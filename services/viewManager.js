import { channelManager } from './channelManager.js';
import { logChannel, logInfo, logError, logWarn } from '../utils/logger.js';
import { validateView, createView, parseRotateAt, isViewScheduled } from '../models/viewSchema.js';
import { validateViewByType } from '../models/viewTypes.js';
import { channelConfig } from './channelConfig.js';
import { viewStorage } from './viewStorage.js';
import { getLatestWebcamImage } from './webcam-db.js';
import { getWeatherData } from './weather-db.js';
import { getMergedEvents } from './calendarService.js';

import sharp from 'sharp';

export class ViewManager {
  constructor() {
    this.currentView = null; // Legacy: global current view
    this.channelCurrentViews = new Map(); // channel -> current view id
    this.viewActivationTime = new Map(); // channel -> { viewId: timestamp }
    this.views = new Map();
    this.rotationInterval = null; // Legacy: global rotation
    this.channelRotations = new Map(); // channel -> { interval, delay, timeout }
    this.rotationDelay = 30000; // 30 seconds default
    this.galleryRotationIndex = new Map(); // viewId -> current rotation index
    this.manualOverrides = new Map(); // channel -> { viewId: timestamp } - tracks manually triggered views
  }

  async loadViews() {
    try {
      const viewsObj = await viewStorage.loadViews();
      for (const [id, view] of Object.entries(viewsObj)) {
        this.views.set(id, view);
      }
      console.log(`Loaded ${this.views.size} views from storage`);
      return true;
    } catch (err) {
      console.error('Error loading views:', err);
      return false;
    }
  }

  async saveViews() {
    return await viewStorage.saveViews(this.views);
  }

  addView(id, view) {
    // Support both old format (just data) and new format (metadata + data)
    let normalizedView;
    
    if (view.metadata && view.data) {
      // New format with metadata and data
      const validation = validateView(view);
      if (!validation.valid) {
        throw new Error(`Invalid view: ${validation.error}`);
      }
      
      // Validate view type-specific data
      const typeValidation = validateViewByType(view.metadata.type, view.data);
      if (!typeValidation.valid) {
        throw new Error(`Invalid view data: ${typeValidation.errors.join(', ')}`);
      }
      
      normalizedView = {
        id,
        metadata: { ...view.metadata },
        data: { ...view.data },
        created_at: Date.now()
      };
    } else {
      // Legacy format - wrap in default metadata
      normalizedView = {
        id,
        metadata: { type: 'custom' },
        data: view,
        created_at: Date.now()
      };
    }
    
    this.views.set(id, normalizedView);
    // Save views asynchronously (don't wait)
    this.saveViews().catch(err => console.error('Error saving views:', err));
    
    if (!this.currentView) {
      this.setCurrentView(id);
    }
  }

  removeView(id) {
    this.views.delete(id);
    // Save views asynchronously (don't wait)
    this.saveViews().catch(err => console.error('Error saving views:', err));
    
    if (this.currentView === id) {
      const nextView = Array.from(this.views.keys())[0] || null;
      this.setCurrentView(nextView);
    }
  }

  getCurrentView(channel = null) {
    if (channel) {
      const viewId = this.channelCurrentViews.get(channel);
      const channelViews = channelConfig.getChannelViews(channel);
      
      // Validate that current view still exists and is in channel's views
      if (viewId && this.views.has(viewId) && channelViews.includes(viewId)) {
        const view = this.views.get(viewId);
        
        // Check if this view is manually overridden FIRST
        const overrideInfo = this.manualOverrides.get(channel);
        const isManuallyOverridden = overrideInfo && overrideInfo.has(viewId);
        
        if (isManuallyOverridden) {
          // View is manually overridden - show it regardless of schedule
          logChannel(`View ${viewId} is manually overridden - showing despite schedule`, channel);
          return view ? { ...view } : null;
        }
        
        // Check if view is scheduled for current time
        if (!isViewScheduled(view)) {
          logChannel(`Current view ${viewId} is not scheduled now, switching view`, channel);
          // Current view is not scheduled, fall through to find a scheduled view
        } else {
          return view ? { ...view } : null;
        }
      }
      
      // Current view is invalid (removed from channel, doesn't exist, or not scheduled)
      // Fallback: get first existing AND scheduled view from channel config
      const existingViews = channelViews
        .filter(id => this.views.has(id))
        .filter(id => isViewScheduled(this.views.get(id)));
      
      if (existingViews.length > 0) {
        const firstView = this.views.get(existingViews[0]);
        if (firstView) {
          this.channelCurrentViews.set(channel, existingViews[0]);
          logChannel(`Switching to scheduled view: ${existingViews[0]}`, channel);
          return { ...firstView };
        }
      }
      
      logChannel(`No scheduled views available at this time`, channel);
      return null;
    }
    // Legacy: global current view
    if (!this.currentView) {
      return null;
    }
    const view = this.views.get(this.currentView);
    return view ? { ...view } : null;
  }

  setCurrentView(id, channel = null, isManualTrigger = false) {
    if (!this.views.has(id)) {
      throw new Error(`View ${id} does not exist`);
    }
    
    const view = this.views.get(id);
    
    if (channel) {
      // Validate view belongs to channel
      const channelViews = channelConfig.getChannelViews(channel);
      if (!channelViews.includes(id)) {
        throw new Error(`View ${id} is not configured for channel ${channel}`);
      }
      
      // Track activation time
      if (!this.viewActivationTime.has(channel)) {
        this.viewActivationTime.set(channel, new Map());
      }
      this.viewActivationTime.get(channel).set(id, Date.now());
      
      // If manually triggered, mark as override
      if (isManualTrigger) {
        if (!this.manualOverrides.has(channel)) {
          this.manualOverrides.set(channel, new Map());
        }
        this.manualOverrides.get(channel).set(id, Date.now());
        logChannel(`View ${id} manually triggered - schedule override active`, channel);
      }
      
      this.channelCurrentViews.set(channel, id);
      this.broadcastViewChange(channel);
      
      // Schedule rotation based on view metadata
      this.scheduleViewRotation(id, channel);
    } else {
      // Legacy: global current view
      this.currentView = id;
      this.broadcastViewChange();
    }
  }

  scheduleViewRotation(viewId, channel) {
    const view = this.views.get(viewId);
    if (!view || !view.metadata) return;

    // Clear any existing timeout for this channel
    const rotation = this.channelRotations.get(channel);
    if (rotation && rotation.timeout) {
      clearTimeout(rotation.timeout);
    }

    let delay = null;

    // Check rotateAfter (milliseconds)
    if (view.metadata.rotateAfter !== undefined) {
      delay = view.metadata.rotateAfter;
    }
    // Check rotateAt (relative time)
    else if (view.metadata.rotateAt) {
      delay = parseRotateAt(view.metadata.rotateAt);
    }

    if (delay !== null && delay > 0) {
      // Filter to only include views that exist and are scheduled for current time
      const allChannelViews = channelConfig.getChannelViews(channel);
      const existingViews = allChannelViews.filter(id => this.views.has(id));
      const scheduledViews = existingViews.filter(id => {
        const scheduled = isViewScheduled(this.views.get(id));
        if (!scheduled) {
          logChannel(`View ${id} filtered out (not scheduled for current time)`, channel);
        }
        return scheduled;
      });
      
      logChannel(`Rotation scheduling: ${scheduledViews.length} views available`, channel, {
        total: allChannelViews.length,
        existing: existingViews.length,
        scheduled: scheduledViews.length
      });

      if (scheduledViews.length <= 1) {
        logChannel(`Not enough views for rotation (need >1, have ${scheduledViews.length})`, channel);
        return;
      }

      const timeout = setTimeout(async () => {
        const currentViewId = this.channelCurrentViews.get(channel);
        if (currentViewId === viewId) {
          // Check if this view was manually triggered (override active)
          const overrideInfo = this.manualOverrides.get(channel);
          const isManuallyOverridden = overrideInfo && overrideInfo.has(viewId);
          
          if (isManuallyOverridden) {
            // Check if the view is still within its scheduled time window
            const view = this.views.get(viewId);
            const stillScheduled = isViewScheduled(view);
            
            if (stillScheduled) {
              // View is still scheduled, keep showing it (override persists)
              logChannel(`View ${viewId} is manually overridden and still scheduled - keeping view`, channel);
              // Reschedule rotation to check again later
              this.scheduleViewRotation(viewId, channel);
              return;
            } else {
              // View is no longer scheduled, clear override and allow rotation
              logChannel(`View ${viewId} is no longer scheduled - clearing manual override`, channel);
              overrideInfo.delete(viewId);
              if (overrideInfo.size === 0) {
                this.manualOverrides.delete(channel);
              }
            }
          }
          
          // Only rotate if this view is still the current view and not manually overridden
          // Re-filter in case views were added/removed or schedule changed
          const currentExistingViews = channelConfig.getChannelViews(channel)
            .filter(id => this.views.has(id))
            .filter(id => isViewScheduled(this.views.get(id)));
          
          logChannel(`Rotation firing`, channel, {
            availableViews: currentExistingViews,
            manuallyOverridden: isManuallyOverridden
          });
          
          if (currentExistingViews.length === 0) {
            logChannel(`No scheduled views available for rotation`, channel);
            return; // No views available
          }
          
          // Find next non-empty gallery view
          const currentIndex = currentExistingViews.indexOf(viewId);
          let attempts = 0;
          let nextIndex = (currentIndex + 1) % currentExistingViews.length;
          
          // Try to find a valid view (skip empty galleries)
          while (attempts < currentExistingViews.length) {
            const nextViewId = currentExistingViews[nextIndex];
            const nextView = this.views.get(nextViewId);
            
            // Check if it's a gallery view
            if (nextView && nextView.metadata && nextView.metadata.type === 'gallery') {
              // Check if it has images
              try {
                const { getGalleryImages } = await import('./gallery-db.js');
                const images = await getGalleryImages(nextViewId);
                
                if (images.length === 0) {
                  logChannel(`Skipping empty gallery view ${nextViewId}`, channel);
                  nextIndex = (nextIndex + 1) % currentExistingViews.length;
                  attempts++;
                  continue; // Try next view
                }
              } catch (err) {
                logError(`Error checking gallery images for ${nextViewId}`, err);
              }
            }
            
            // Found a valid view (non-gallery or gallery with images)
            try {
              // Clear any manual override when rotating to a new view
              if (overrideInfo) {
                overrideInfo.delete(viewId);
                if (overrideInfo.size === 0) {
                  this.manualOverrides.delete(channel);
                }
              }
              this.setCurrentView(currentExistingViews[nextIndex], channel, false);
            } catch (err) {
              logError(`Error rotating view in channel ${channel}`, err);
            }
            break;
          }
          
          if (attempts >= currentExistingViews.length) {
            logChannel(`All views are empty galleries, staying on current view`, channel);
          }
        }
      }, delay);

      // Update rotation info
      if (!rotation) {
        this.channelRotations.set(channel, { timeout, delay });
      } else {
        rotation.timeout = timeout;
        rotation.delay = delay;
      }

      // Calculate when the rotation will happen
      const rotationTime = new Date(Date.now() + delay);
      const delaySeconds = Math.round(delay / 1000);
      const delayMinutes = Math.round(delay / 60000);
      
      let delayStr;
      if (delaySeconds < 60) {
        delayStr = `${delaySeconds} second${delaySeconds !== 1 ? 's' : ''}`;
      } else if (delayMinutes < 60) {
        delayStr = `${delayMinutes} minute${delayMinutes !== 1 ? 's' : ''}`;
      } else {
        const hours = Math.floor(delayMinutes / 60);
        const mins = delayMinutes % 60;
        delayStr = `${hours} hour${hours !== 1 ? 's' : ''}${mins > 0 ? ` ${mins} minute${mins !== 1 ? 's' : ''}` : ''}`;
      }
      
      logChannel(`Scheduled view rotation`, channel, {
        currentView: viewId,
        nextRotationIn: delayStr,
        at: rotationTime.toLocaleTimeString()
      });
    }
  }

  getAllViews() {
    return Array.from(this.views.values());
  }

  getView(id) {
    return this.views.get(id);
  }

  async broadcastViewChange(channel = null) {
    const targetChannel = channel || 'kiosk';
    let view = this.getCurrentView(targetChannel);
    
    // Skip gallery views with no images
    if (view && view.metadata && view.metadata.type === 'gallery') {
      const { getGalleryImages } = await import('./gallery-db.js');
      const images = await getGalleryImages(view.id);
      
      if (images.length === 0) {
        console.log(`[Gallery] Skipping view ${view.id} - no images available`);
        // Move to next view
        this.nextView(targetChannel);
        return; // Don't broadcast this empty gallery view
      }
    }
    
    if (view) {
      try {
        // Optimization for webcam views: inject metadata AND image buffer to avoid extra roundtrip
        if (view.metadata && view.metadata.type === 'webcam' && view.data && view.data.webcamId) {
          try {
            const image = getLatestWebcamImage(view.data.webcamId);
            if (image) {
              // Inject metadata directly into view data
              view.data.meta = {
                t: image.created_at,
                created_at: image.created_at,
                now: Date.now()
              };
              
              // Get image buffer, resize, and convert to base64
              try {
                const b64Start = Date.now();
                const { getWebcamImageBuffer } = await import('./webcam-db.js');
                let buffer = getWebcamImageBuffer(image);
                
                if (buffer) {
                  // Resize on server before sending (max width 800px to keep payload small)
                  try {
                    buffer = await sharp(buffer)
                      .resize({
                        width: 800,
                        withoutEnlargement: true,
                        fit: 'inside'
                      })
                      .jpeg({ quality: 80 })
                      .toBuffer();
                  } catch (resizeErr) {
                    console.error(`Error resizing image for ${view.data.webcamId}:`, resizeErr);
                  }

                  view.data.image = {
                    base64: buffer.toString('base64'),
                    contentType: 'image/jpeg'
                  };
                  console.log(`[Perf] Processed image for ${view.data.webcamId}. Resize+Encode took ${Date.now() - b64Start}ms. Size: ${view.data.image.base64.length} chars`);
                }
              } catch (bufferErr) {
                console.error(`Error reading image buffer for ${view.data.webcamId}:`, bufferErr);
              }
            }
          } catch (e) {
            console.error(`Error injecting webcam data for ${view.data.webcamId}:`, e);
          }
        }

        // Optimization for weather views: inject cached weather data
        if (view.metadata && view.metadata.type === 'weather' && view.data && view.data.location) {
          try {
            const weatherData = getWeatherData(view.data.location);
            if (weatherData) {
              // Inject cached weather data directly into view data
              view.data.weather = weatherData;
            }
          } catch (e) {
            console.error(`Error injecting weather data for ${view.data.location.name}:`, e);
          }
        }

        // Optimization for calendar views: inject events to avoid extra roundtrip
        if (view.metadata && view.metadata.type === 'calendar' && view.data && view.data.sources) {
          try {
            const events = await getMergedEvents(view.data.sources);
            if (events) {
              view.data.events = events;
            }
          } catch (e) {
            console.error(`Error injecting calendar events for ${view.id}:`, e);
          }
        }

        // Optimization for gallery views: inject image data for current rotation image
        if (view.metadata && view.metadata.type === 'gallery') {
          try {
            const { getGalleryImages } = await import('./gallery-db.js');
            const images = await getGalleryImages(view.id);
            
            if (images.length > 0) {
              // Get current rotation index
              let currentIndex = this.galleryRotationIndex.get(view.id) || 0;
              
              // Ensure index is valid
              if (currentIndex >= images.length) {
                currentIndex = 0;
                this.galleryRotationIndex.set(view.id, 0);
              }
              
              const image = images[currentIndex];
              
              // Update rotation index for next time
              this.galleryRotationIndex.set(view.id, (currentIndex + 1) % images.length);
              
              // Read image file and encode as base64
              try {
                const { getGalleryImagePath } = await import('./gallery-db.js');
                const fs = await import('fs/promises');
                const imagePath = getGalleryImagePath(image.filename);
                
                const b64Start = Date.now();
                let buffer = await fs.readFile(imagePath);
                
                // Try to resize image with Sharp
                try {
                  buffer = await sharp(buffer)
                    .resize({
                      width: 800,
                      withoutEnlargement: true,
                      fit: 'inside'
                    })
                    .jpeg({ quality: 80 })
                    .toBuffer();
                  console.log(`[Gallery] Resized image ${image.id}`);
                } catch (sharpErr) {
                  console.warn(`[Gallery] Failed to resize image ${image.id}, using original: ${sharpErr.message}`);
                  // Use original buffer if Sharp fails
                }
                
                view.data.imageId = image.id;
                view.data.imageUrl = `/api/gallery/images/${image.id}`;
                view.data.caption = image.caption || view.data.caption || '';
                view.data.image = {
                  base64: buffer.toString('base64'),
                  contentType: image.mime_type || 'image/jpeg'
                };
                
                console.log(`[Perf] Processed gallery image ${image.id} for rotation. Time: ${Date.now() - b64Start}ms. Size: ${view.data.image.base64.length} chars`);
              } catch (err) {
                console.error(`Error reading gallery image file for ${view.id}:`, err);
                // Continue without image data
              }
            } else {
              console.log(`[Gallery] No images available for view ${view.id}`);
            }
          } catch (e) {
            console.error(`Error injecting gallery data for ${view.id}:`, e);
          }
        }

        const message = {
          type: 'view_change',
          view: view
        };
        //logChannel(`Broadcasting view change`, targetChannel, message);
        await channelManager.sendToChannel(targetChannel, message);
      } catch (err) {
        console.error('Error broadcasting view change:', err);
      }
    }
  }

  startRotation(delay = null, channel = null) {
    if (channel) {
      const channelViews = channelConfig.getChannelViews(channel);
      // Filter to only include views that exist and are scheduled for current time
      const existingViews = channelViews
        .filter(id => this.views.has(id))
        .filter(id => isViewScheduled(this.views.get(id)));
      
      if (existingViews.length <= 1) {
        if (channelViews.length > existingViews.length) {
          console.warn(`Channel ${channel} has ${channelViews.length - existingViews.length} views that don't exist or aren't scheduled`);
        }
        return;
      }
      
      // Stop existing rotation for this channel
      this.stopRotation(channel);
      
      // Always use per-view timing (rotateAfter/rotateAt) - set and schedule first view
      let currentViewId = this.channelCurrentViews.get(channel);
      if (!currentViewId || !this.views.has(currentViewId)) {
        // No current view set, set the first one
        currentViewId = existingViews[0];
        if (currentViewId) {
          this.channelCurrentViews.set(channel, currentViewId);
          // Broadcast the initial view
          this.broadcastViewChange(channel);
        }
      }
      
      if (currentViewId && this.views.has(currentViewId)) {
        this.scheduleViewRotation(currentViewId, channel);
      }
    } else {
      // Legacy: global rotation (deprecated - use channels instead)
      if (delay) {
        this.rotationDelay = delay;
      }
      
      if (this.rotationInterval) {
        clearInterval(this.rotationInterval);
      }

      if (this.views.size <= 1) {
        return;
      }

      this.rotationInterval = setInterval(() => {
        const viewIds = Array.from(this.views.keys());
        const currentIndex = viewIds.indexOf(this.currentView);
        const nextIndex = (currentIndex + 1) % viewIds.length;
        this.setCurrentView(viewIds[nextIndex]);
      }, this.rotationDelay);
    }
  }

  stopRotation(channel = null) {
    if (channel) {
      const rotation = this.channelRotations.get(channel);
      if (rotation) {
        // Only clear timeout (per-view timing), no interval anymore
        if (rotation.timeout) {
          clearTimeout(rotation.timeout);
        }
        this.channelRotations.delete(channel);
      }
    } else {
      // Legacy: global rotation
      if (this.rotationInterval) {
        clearInterval(this.rotationInterval);
        this.rotationInterval = null;
      }
    }
  }

  triggerView(id, channel = null) {
    if (this.views.has(id)) {
      this.setCurrentView(id, channel);
    }
  }

  getChannelViews(channel) {
    const viewIds = channelConfig.getChannelViews(channel);
    return viewIds
      .map(id => this.views.get(id))
      .filter(view => view !== undefined);
  }

  async nextView(channel) {
    if (!channel) return;
    const allChannelViews = channelConfig.getChannelViews(channel).filter(id => this.views.has(id));
    if (allChannelViews.length === 0) return;

    // Filter to only scheduled views
    const scheduledViews = allChannelViews.filter(id => isViewScheduled(this.views.get(id)));
    if (scheduledViews.length === 0) {
      logChannel(`No scheduled views available for next`, channel);
      return;
    }

    const currentViewId = this.channelCurrentViews.get(channel);
    let nextIndex = 0;
    if (currentViewId) {
      const currentIndex = scheduledViews.indexOf(currentViewId);
      if (currentIndex !== -1) {
        nextIndex = (currentIndex + 1) % scheduledViews.length;
      }
      // If current view is not in scheduled views, start from beginning
    }
    
    // Skip empty gallery views
    let attempts = 0;
    while (attempts < scheduledViews.length) {
      const nextViewId = scheduledViews[nextIndex];
      const nextView = this.views.get(nextViewId);
      
      if (nextView && nextView.metadata && nextView.metadata.type === 'gallery') {
        try {
          const { getGalleryImages } = await import('./gallery-db.js');
          const images = await getGalleryImages(nextViewId);
          
          if (images.length === 0) {
            logChannel(`Skipping empty gallery view ${nextViewId} in next()`, channel);
            nextIndex = (nextIndex + 1) % scheduledViews.length;
            attempts++;
            continue;
          }
        } catch (err) {
          logError(`Error checking gallery images for ${nextViewId}`, err);
        }
      }
      
      // Found valid view
      logChannel(`Next view: ${scheduledViews[nextIndex]}`, channel, { from: currentViewId });
      this.setCurrentView(scheduledViews[nextIndex], channel);
      return;
    }
    
    logChannel(`All views are empty galleries, staying on current view`, channel);
  }

  async previousView(channel) {
    if (!channel) return;
    const allChannelViews = channelConfig.getChannelViews(channel).filter(id => this.views.has(id));
    if (allChannelViews.length === 0) return;

    // Filter to only scheduled views
    const scheduledViews = allChannelViews.filter(id => isViewScheduled(this.views.get(id)));
    if (scheduledViews.length === 0) {
      logChannel(`No scheduled views available for previous`, channel);
      return;
    }

    const currentViewId = this.channelCurrentViews.get(channel);
    let prevIndex = scheduledViews.length - 1;
    if (currentViewId) {
      const currentIndex = scheduledViews.indexOf(currentViewId);
      if (currentIndex !== -1) {
        prevIndex = (currentIndex - 1 + scheduledViews.length) % scheduledViews.length;
      }
      // If current view is not in scheduled views, start from end
    }
    
    // Skip empty gallery views
    let attempts = 0;
    while (attempts < scheduledViews.length) {
      const prevViewId = scheduledViews[prevIndex];
      const prevView = this.views.get(prevViewId);
      
      if (prevView && prevView.metadata && prevView.metadata.type === 'gallery') {
        try {
          const { getGalleryImages } = await import('./gallery-db.js');
          const images = await getGalleryImages(prevViewId);
          
          if (images.length === 0) {
            logChannel(`Skipping empty gallery view ${prevViewId} in previous()`, channel);
            prevIndex = (prevIndex - 1 + scheduledViews.length) % scheduledViews.length;
            attempts++;
            continue;
          }
        } catch (err) {
          logError(`Error checking gallery images for ${prevViewId}`, err);
        }
      }
      
      // Found valid view
      logChannel(`Previous view: ${scheduledViews[prevIndex]}`, channel, { from: currentViewId });
      this.setCurrentView(scheduledViews[prevIndex], channel);
      return;
    }
    
    logChannel(`All views are empty galleries, staying on current view`, channel);
  }

  async triggerGalleryImage(viewId, image) {
    // Find all channels that contain this view
    const channels = channelConfig.getAllChannels();
    const targetChannels = [];
    
    for (const channel of channels) {
      const channelViews = channelConfig.getChannelViews(channel);
      if (channelViews.includes(viewId)) {
        targetChannels.push(channel);
      }
    }
    
    if (targetChannels.length === 0) {
      logWarn(`No channels found containing view ${viewId}`);
      return;
    }
    
    // Get the view
    const view = this.views.get(viewId);
    if (!view) {
      throw new Error(`View ${viewId} not found`);
    }
    
    // Read image file and encode as base64
    let imageData = null;
    try {
      const { getGalleryImagePath } = await import('./gallery-db.js');
      const fs = await import('fs/promises');
      const imagePath = getGalleryImagePath(image.filename);
      
      const b64Start = Date.now();
      let buffer = await fs.readFile(imagePath);
      let contentType = image.mime_type || 'image/jpeg';
      
      // Try to resize on server before sending (max width 800px to keep payload small)
      try {
        buffer = await sharp(buffer)
          .resize({
            width: 800,
            withoutEnlargement: true,
            fit: 'inside'
          })
          .jpeg({ quality: 80 })
          .toBuffer();
        contentType = 'image/jpeg'; // Sharp converts to JPEG
        logInfo(`[Gallery] Resized image ${image.id}`);
      } catch (resizeErr) {
        logWarn(`[Gallery] Failed to resize image ${image.id}, using original: ${resizeErr.message}`);
        // Use original buffer if Sharp fails
      }
      
      imageData = {
        base64: buffer.toString('base64'),
        contentType: contentType
      };
      
      logInfo(`[Perf] Processed gallery image ${image.id}`, { 
        timeMs: Date.now() - b64Start, 
        sizeBytes: imageData.base64.length 
      });
    } catch (err) {
      logError(`Error reading gallery image file ${image.filename}`, err);
      // Continue without image data - client will fetch via URL
    }
    
    // Create updated view with the specific image
    const updatedView = {
      ...view,
      data: {
        ...view.data,
        imageId: image.id,
        imageUrl: `/api/gallery/images/${image.id}`,
        caption: image.caption || view.data.caption || '',
        image: imageData // Include base64 image data
      }
    };
    
    // Broadcast to all channels containing this view
    for (const channel of targetChannels) {
      try {
        // Set as current view for this channel
        this.channelCurrentViews.set(channel, viewId);
        
        const message = {
          type: 'view_change',
          view: updatedView
        };
        await channelManager.sendToChannel(channel, message);
        logChannel(`Triggered gallery view ${viewId} for image ${image.id}`, channel);
        
        // Schedule rotation for this view
        this.scheduleViewRotation(viewId, channel);
      } catch (err) {
        logError(`Error triggering gallery on channel ${channel}`, err);
      }
    }
  }

  async triggerGalleryView(viewId, channel = null) {
    // Trigger a gallery view, showing the next image in rotation
    const { getGalleryImages } = await import('./gallery-db.js');
    const images = await getGalleryImages(viewId);
    
    if (images.length === 0) {
      throw new Error(`No images found for gallery view ${viewId}`);
    }
    
    // Get current rotation index for this view
    let currentIndex = this.galleryRotationIndex.get(viewId) || 0;
    
    // Get the image at current index
    const image = images[currentIndex];
    
    // Update rotation index for next time (wrap around)
    this.galleryRotationIndex.set(viewId, (currentIndex + 1) % images.length);
    
    // Trigger with this image
    await this.triggerGalleryImage(viewId, image);
  }
}


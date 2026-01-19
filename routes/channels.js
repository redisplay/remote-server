import express from 'express';
import { channelManager } from '../services/channelManager.js';
import { channelConfig } from '../services/channelConfig.js';

export function createChannelRoutes(viewManager) {
  const router = express.Router();

  // Handle quadrant tap
  router.post('/:channel/tap', async (req, res) => {
    const { channel } = req.params;
    const { quadrant } = req.body;
    
    if (!viewManager) {
      return res.status(500).json({ error: 'ViewManager not available' });
    }

    const config = channelConfig.getChannelConfig(channel);
    if (config && config.quadrants && config.quadrants[quadrant]) {
      const targetViewId = config.quadrants[quadrant];
      console.log(`[Channel ${channel}] Tap ${quadrant} -> Action ${targetViewId}`);
      
      // Validate that the target view exists in the channel (except for special actions)
      if (targetViewId !== 'NEXT' && targetViewId !== 'PREVIOUS') {
        if (!config.views || !config.views.includes(targetViewId)) {
          console.error(`[Channel ${channel}] View ${targetViewId} is not in channel views, ignoring tap`);
          return res.status(400).json({ error: `View ${targetViewId} is not configured for this channel` });
        }
      }
      
      try {
        if (targetViewId === 'NEXT') {
             await viewManager.nextView(channel);
             return res.json({ success: true, action: 'next' });
        } else if (targetViewId === 'PREVIOUS') {
             await viewManager.previousView(channel);
             return res.json({ success: true, action: 'previous' });
        } else {
             // Mark as manual trigger to override schedule
             viewManager.setCurrentView(targetViewId, channel, true);
             return res.json({ success: true, action: 'jump', view: targetViewId });
        }
      } catch (err) {
        console.error(`Error switching to view ${targetViewId}:`, err);
        return res.status(500).json({ error: err.message });
      }
    }
    
    // Fallback: if no quadrant mapping, maybe treat as "next" or do nothing?
    // User asked for specific mapping behavior. If not assigned, do nothing (or generic next).
    // Let's default to "next" if TOP_RIGHT or BOTTOM_RIGHT (right side), 
    // and "previous" if TOP_LEFT or BOTTOM_LEFT (left side) as a fallback?
    // User said: "it could be possible that not all quadrants are assigned"
    // So if not assigned, we do NOTHING or fall back to default behavior.
    // Given the prompt "single tap event on views to act like a swipe to the right",
    // maybe we should keep that as default if no quadrant is mapped?
    
    // For now, let's explicitly fallback to "next" if no quadrant mapping exists,
    // to preserve the previous "tap to next" behavior if user hasn't configured quadrants yet.
    console.log(`[Channel ${channel}] Tap ${quadrant} -> No mapping, defaulting to next view`);
    await viewManager.nextView(channel);
    res.json({ success: true, action: 'next' });
  });

  // Send message to a channel
  router.post('/:channel', (req, res) => {
    const { channel } = req.params;
    const message = req.body;
    
    channelManager.sendToChannel(channel, message);
    res.json({ success: true, channel, message });
  });

  // Skip to next view
  router.post('/:channel/next', async (req, res) => {
    const { channel } = req.params;
    if (viewManager) {
      await viewManager.nextView(channel);
      res.json({ success: true });
    } else {
      res.status(500).json({ error: 'ViewManager not available' });
    }
  });

  // Go to previous view
  router.post('/:channel/previous', async (req, res) => {
    const { channel } = req.params;
    if (viewManager) {
      await viewManager.previousView(channel);
      res.json({ success: true });
    } else {
      res.status(500).json({ error: 'ViewManager not available' });
    }
  });

  // Get all connected clients across all channels (must come before /:channel/clients)
  router.get('/clients', (req, res) => {
    const clients = channelManager.getConnectedClients();
    const stats = channelManager.getChannelStats();
    
    res.json({
      totalClients: clients.length,
      clients,
      channels: stats
    });
  });

  // Get connected clients for a specific channel
  router.get('/:channel/clients', (req, res) => {
    const { channel } = req.params;
    const clients = channelManager.getConnectedClients(channel);
    res.json({
      channel,
      clientCount: clients.length,
      clients
    });
  });

  return router;
}


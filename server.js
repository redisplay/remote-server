import express from 'express';
import cors from 'cors';
import os from 'os';
import morgan from 'morgan';
import { createSSEHandler } from './routes/sse.js';
import { createViewRoutes } from './routes/views.js';
import { createChannelRoutes } from './routes/channels.js';
import { createChannelConfigRoutes } from './routes/channelConfig.js';
import { createProxyRoutes } from './routes/proxy.js';
import { createWebcamRoutes } from './routes/webcams.js';
import { createWeatherRoutes } from './routes/weather.js';
import { createCalendarRoutes } from './routes/calendars.js';
import { createGalleryRoutes } from './routes/gallery.js';
import { ViewManager } from './services/viewManager.js';
import { channelConfig } from './services/channelConfig.js';
import { channelManager } from './services/channelManager.js';
import { initializeWebcamDb } from './services/webcam-db.js';
import { initializeWeatherDb } from './services/weather-db.js';
import { initializeGalleryDb } from './services/gallery-db.js';
import { startWeatherFetcher } from './services/weatherFetcher.js';
import { BleService } from './services/ble/BleService.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Standard logging for non-SSE requests
app.use(morgan('dev', {
  skip: function (req, res) { return req.originalUrl.startsWith('/sse'); }
}));

// SSE Logging: Start of connection
app.use(morgan(':method :url - SSE CONNECTED :remote-addr', {
  immediate: true,
  skip: function (req, res) { return !req.originalUrl.startsWith('/sse'); }
}));

// SSE Logging: End of connection (duration)
app.use(morgan(':method :url - SSE DISCONNECTED :remote-addr - Duration: :response-time ms', {
  skip: function (req, res) { return !req.originalUrl.startsWith('/sse'); }
}));

// Initialize services
await channelConfig.load();
initializeWebcamDb(); // Initialize webcam database
initializeWeatherDb(); // Initialize weather database
await initializeGalleryDb(); // Initialize gallery database
const viewManager = new ViewManager();
await viewManager.loadViews();

// Start background weather fetcher (after views are loaded)
startWeatherFetcher(viewManager);

// Initialize channel rotations - always use per-view rotateAfter values
const channels = channelConfig.getAllChannels();
for (const channel of channels) {
  viewManager.startRotation(null, channel);
}


// Routes
app.use('/sse', createSSEHandler(viewManager));
app.use('/api/views', createViewRoutes(viewManager));
app.use('/api/channels', createChannelRoutes(viewManager));
app.use('/api/channel-config', createChannelConfigRoutes());
app.use('/api/proxy', createProxyRoutes());
app.use('/api/webcams', createWebcamRoutes());
app.use('/api/weather', createWeatherRoutes());
app.use('/api/calendars', createCalendarRoutes(viewManager));
app.use('/api/gallery', createGalleryRoutes(viewManager));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Rekiosk server running on port ${PORT}`);
  console.log(`Server accessible at:`);
  console.log(`  - http://localhost:${PORT}`);
  console.log(`  - http://127.0.0.1:${PORT}`);
  
  try {
    const networkInterfaces = os.networkInterfaces();
    Object.keys(networkInterfaces).forEach((ifname) => {
      networkInterfaces[ifname].forEach((iface) => {
        // Skip internal (i.e. 127.0.0.1) and non-ipv4 addresses
        if ('IPv4' !== iface.family || iface.internal) {
          return;
        }
        console.log(`  - http://${iface.address}:${PORT}`);
      });
    });
  } catch (e) {
    console.warn('Could not list network interfaces:', e);
  }

  // Initialize BLE Service
  try {
    console.log('Initializing BLE Service...');
    new BleService(viewManager);
  } catch (err) {
    console.error('Failed to initialize BLE Service:', err);
  }
});


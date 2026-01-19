import { logChannel } from '../utils/logger.js';
import { rewriteImageUrls } from '../utils/imageProxy.js';

const channels = new Map(); // channel -> Set of SSE response objects
const clientMap = new Map(); // res -> { clientId, channel, ip }
const ipConnections = new Map(); // ip -> Set of { res, channel }

function broadcastToChannel(channel, message) {
  const clients = channels.get(channel);
  if (clients) {
    // Rewrite image URLs in view messages
    let processedMessage = message;
    if (message.type === 'initial_view' || message.type === 'view_change') {
      if (message.view) {
        processedMessage = {
          ...message,
          view: rewriteImageUrls(message.view)
        };
      }
    }
    
    clients.forEach((res) => {
      try {
        const clientInfo = clientMap.get(res);
        res.write(`data: ${JSON.stringify(processedMessage)}\n\n`);
        if (clientInfo) {
          // logChannel(`Message sent to client`, channel, { 
          //   clientId: clientInfo.clientId, 
          //   message: processedMessage
          // });
        }
      } catch (err) {
        console.error('Error sending to client:', err);
        const clientInfo = clientMap.get(res);
        if (clientInfo) {
          logChannel(`Error sending to client, removing`, channel, { 
            clientId: clientInfo.clientId, 
            error: err.message 
          });
        }
        channels.get(channel)?.delete(res);
        clientMap.delete(res);
      }
    });
  }
}

export class ChannelManager {
  async subscribeClient(channel, res, clientId, ip) {
    // Close any existing connections from the same IP
    if (ipConnections.has(ip)) {
      const existingConnections = ipConnections.get(ip);
      logChannel(`Closing ${existingConnections.size} existing connection(s) from same IP`, channel, { 
        ip, 
        clientId 
      });
      
      // Close all existing connections from this IP
      for (const connInfo of existingConnections) {
        try {
          if (connInfo.res && !connInfo.res.destroyed) {
            connInfo.res.destroy();
          }
        } catch (err) {
          // Connection might already be closed
        }
        // Remove from channels
        const channelClients = channels.get(connInfo.channel);
        if (channelClients) {
          channelClients.delete(connInfo.res);
        }
        clientMap.delete(connInfo.res);
      }
      ipConnections.delete(ip);
    }
    
    if (!channels.has(channel)) {
      channels.set(channel, new Set());
    }
    
    channels.get(channel).add(res);
    clientMap.set(res, { clientId, channel, ip });
    
    // Track by IP
    if (!ipConnections.has(ip)) {
      ipConnections.set(ip, new Set());
    }
    ipConnections.get(ip).add({ res, channel });
    
    logChannel(`Client subscribed`, channel, { 
      clientId, 
      ip,
      totalClients: channels.get(channel).size 
    });
    
    res.on('close', () => {
      this.unsubscribeClient(channel, res);
    });
  }

  async unsubscribeClient(channel, res) {
    const clients = channels.get(channel);
    const clientInfo = clientMap.get(res);
    
    if (clients) {
      clients.delete(res);
      
      // Remove from IP tracking
      if (clientInfo && clientInfo.ip) {
        const ipConns = ipConnections.get(clientInfo.ip);
        if (ipConns) {
          for (const connInfo of ipConns) {
            if (connInfo.res === res) {
              ipConns.delete(connInfo);
              break;
            }
          }
          if (ipConns.size === 0) {
            ipConnections.delete(clientInfo.ip);
          }
        }
      }
      
      clientMap.delete(res);
      
      if (clientInfo) {
        logChannel(`Client unsubscribed`, channel, { 
          clientId: clientInfo.clientId, 
          ip: clientInfo.ip,
          remainingClients: clients.size 
        });
      }
      
      if (clients.size === 0) {
        channels.delete(channel);
      }
    }
  }

  async sendToChannel(channel, message) {
    logChannel(`Publishing message to channel`, channel, message);
    broadcastToChannel(channel, message);
  }

  getConnectedClients(channel = null) {
    const clients = [];
    
    const extractClientInfo = (clientInfo) => {
      // Extract connection time from clientId (format: ip-timestamp)
      // clientId is generated as `${req.ip}-${Date.now()}` in sse.js
      const parts = clientInfo.clientId.split('-');
      let timestamp = null;
      
      // Try to parse the last part as a timestamp (should be numeric)
      if (parts.length > 0) {
        const lastPart = parts[parts.length - 1];
        const parsed = parseInt(lastPart);
        if (!isNaN(parsed) && parsed > 0) {
          timestamp = parsed;
        }
      }
      
      const connectedAt = timestamp ? new Date(timestamp) : null;
      
      return {
        clientId: clientInfo.clientId,
        channel: clientInfo.channel,
        ip: clientInfo.ip,
        connectedAt: connectedAt ? connectedAt.toISOString() : null,
        connectedAtTimestamp: timestamp
      };
    };
    
    if (channel) {
      // Get clients for a specific channel
      const channelClients = channels.get(channel);
      if (channelClients) {
        channelClients.forEach((res) => {
          const clientInfo = clientMap.get(res);
          if (clientInfo) {
            clients.push(extractClientInfo(clientInfo));
          }
        });
      }
    } else {
      // Get all clients across all channels
      clientMap.forEach((clientInfo, res) => {
        clients.push(extractClientInfo(clientInfo));
      });
    }
    
    return clients;
  }

  getChannelStats() {
    const stats = {};
    
    channels.forEach((channelClients, channel) => {
      const clientList = [];
      channelClients.forEach((res) => {
        const clientInfo = clientMap.get(res);
        if (clientInfo) {
          // Extract connection time from clientId (format: ip-timestamp)
          const parts = clientInfo.clientId.split('-');
          let timestamp = null;
          
          if (parts.length > 0) {
            const lastPart = parts[parts.length - 1];
            const parsed = parseInt(lastPart);
            if (!isNaN(parsed) && parsed > 0) {
              timestamp = parsed;
            }
          }
          
          const connectedAt = timestamp ? new Date(timestamp) : null;
          
          clientList.push({
            clientId: clientInfo.clientId,
            ip: clientInfo.ip,
            connectedAt: connectedAt ? connectedAt.toISOString() : null,
            connectedAtTimestamp: timestamp
          });
        }
      });
      
      stats[channel] = {
        clientCount: channelClients.size,
        clients: clientList
      };
    });
    
    return stats;
  }
}

export const channelManager = new ChannelManager();


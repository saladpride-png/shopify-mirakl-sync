// ============================================
// SHOPIFY-MIRAKL INTEGRATION APPLICATION
// ============================================
// This app syncs products, inventory, orders, and tracking
// between Shopify and Mirakl marketplace

const axios = require('axios');
const FormData = require('form-data');
const cron = require('node-cron');
const fs = require('fs');

// ============================================
// CONFIGURATION - Uses Environment Variables
// ============================================
// You can set these in Railway/Heroku or edit directly here
const config = {
  shopify: {
    storeName: process.env.SHOPIFY_STORE_NAME || 'YOUR_STORE_NAME',
    accessToken: process.env.SHOPIFY_ACCESS_TOKEN || 'YOUR_SHOPIFY_ACCESS_TOKEN',
    apiVersion: process.env.SHOPIFY_API_VERSION || '2024-01'
  },
  mirakl: {
    apiUrl: process.env.MIRAKL_API_URL || 'https://YOUR_INSTANCE.mirakl.net',
    apiKey: process.env.MIRAKL_API_KEY || 'YOUR_MIRAKL_API_KEY',
    shopId: process.env.MIRAKL_SHOP_ID || 'YOUR_SHOP_ID'
  },
  sync: {
    enabled: process.env.SYNC_ENABLED !== 'false',
    schedules: {
      products: process.env.SCHEDULE_PRODUCTS || '0 */6 * * *',
      inventory: process.env.SCHEDULE_INVENTORY || '*/30 * * * *',
      orders: process.env.SCHEDULE_ORDERS || '*/15 * * * *',
      tracking: process.env.SCHEDULE_TRACKING || '*/20 * * * *'
    }
  }
};

// ============================================
// SHOPIFY API CLIENT
// ============================================
class ShopifyClient {
  constructor(config) {
    this.baseUrl = `https://${config.storeName}.myshopify.com/admin/api/${config.apiVersion}`;
    this.headers = {
      'X-Shopify-Access-Token': config.accessToken,
      'Content-Type': 'application/json'
    };
  }

  async getProducts(limit = 250) {
    try {
      const response = await axios.get(`${this.baseUrl}/products.json`, {
        headers: this.headers,
        params: { limit }
      });
      return response.data.products;
    } catch (error) {
      console.error('❌ Error fetching Shopify products:', error.response?.data || error.message);
      throw error;
    }
  }

  async getInventoryLevels(inventoryItemIds) {
    try {
      const response = await axios.get(`${this.baseUrl}/inventory_levels.json`, {
        headers: this.headers,
        params: { inventory_item_ids: inventoryItemIds.join(',') }
      });
      return response.data.inventory_levels;
    } catch (error) {
      console.error('❌ Error fetching inventory levels:', error.response?.data || error.message);
      throw error;
    }
  }

  async createOrder(orderData) {
    try {
      const response = await axios.post(`${this.baseUrl}/orders.json`, {
        order: orderData
      }, { headers: this.headers });
      return response.data.order;
    } catch (error) {
      console.error('❌ Error creating Shopify order:', error.response?.data || error.message);
      throw error;
    }
  }

  async getFulfillments(orderId) {
    try {
      const response = await axios.get(`${this.baseUrl}/orders/${orderId}/fulfillments.json`, {
        headers: this.headers
      });
      return response.data.fulfillments;
    } catch (error) {
      console.error('❌ Error fetching fulfillments:', error.response?.data || error.message);
      throw error;
    }
  }

  async getOrdersSince(sinceId = null) {
    try {
      const params = { status: 'any', limit: 250 };
      if (sinceId) params.since_id = sinceId;
      
      const response = await axios.get(`${this.baseUrl}/orders.json`, {
        headers: this.headers,
        params
      });
      return response.data.orders;
    } catch (error) {
      console.error('❌ Error fetching orders:', error.response?.data || error.message);
      throw error;
    }
  }
}

// ============================================
// MIRAKL API CLIENT
// ============================================
class MiraklClient {
  constructor(config) {
    this.baseUrl = config.apiUrl;
    this.headers = {
      'Authorization': config.apiKey,
      'Content-Type': 'application/json'
    };
    this.shopId = config.shopId;
  }

  async importProducts(csvContent) {
    try {
      const formData = new FormData();
      formData.append('file', Buffer.from(csvContent), {
        filename: 'offers.csv',
        contentType: 'text/csv'
      });
      
      // Use OFFERS API endpoint (not products)
      const response = await axios.post(`${this.baseUrl}/api/offers/imports`, formData, {
        headers: {
          'Authorization': this.headers.Authorization,
          ...formData.getHeaders()
        },
        params: {
          shop: this.shopId,
          import_mode: 'NORMAL'
        }
      });
      return response.data;
    } catch (error) {
      console.error('❌ Error importing offers to Mirakl:', error.response?.data || error.message);
      throw error;
    }
  }

  async updateOffers(offersData) {
    try {
      const formData = new FormData();
      formData.append('file', Buffer.from(offersData), {
        filename: 'offers.csv',
        contentType: 'text/csv'
      });

      const response = await axios.post(`${this.baseUrl}/api/offers/imports`, formData, {
        headers: {
          'Authorization': this.headers.Authorization,
          ...formData.getHeaders()
        },
        params: {
          import_mode: 'NORMAL'
        }
      });
      return response.data;
    } catch (error) {
      console.error('❌ Error updating Mirakl offers:', error.response?.data || error.message);
      throw error;
    }
  }

  async getOrders(lastRequestDate = null) {
    try {
      const params = {};
      if (lastRequestDate) {
        params.start_date = lastRequestDate;
      }

      const response = await axios.get(`${this.baseUrl}/api/orders`, {
        headers: this.headers,
        params
      });
      return response.data.orders || [];
    } catch (error) {
      console.error('❌ Error fetching Mirakl orders:', error.response?.data || error.message);
      throw error;
    }
  }

  async updateTracking(orderId, trackingInfo) {
    try {
      const response = await axios.put(`${this.baseUrl}/api/orders/${orderId}/tracking`, {
        tracking: trackingInfo
      }, { headers: this.headers });
      return response.data;
    } catch (error) {
      console.error('❌ Error updating tracking in Mirakl:', error.response?.data || error.message);
      throw error;
    }
  }
}

// ============================================
// SYNC MANAGER
// ============================================
class SyncManager {
  constructor(shopifyClient, miraklClient) {
    this.shopify = shopifyClient;
    this.mirakl = miraklClient;
    this.syncState = this.loadSyncState();
  }

  loadSyncState() {
    try {
      if (fs.existsSync('sync-state.json')) {
        return JSON.parse(fs.readFileSync('sync-state.json', 'utf8'));
      }
    } catch (error) {
      console.error('⚠️  Error loading sync state:', error.message);
    }
    return {
      lastProductSync: null,
      lastInventorySync: null,
      lastOrderSync: null,
      lastTrackingSync: null,
      processedOrders: []
    };
  }

  saveSyncState() {
    try {
      fs.writeFileSync('sync-state.json', JSON.stringify(this.syncState, null, 2));
    } catch (error) {
      console.error('⚠️  Error saving sync state:', error.message);
    }
  }

  // ============================================
  // PRODUCT/OFFER SYNC: Shopify → Mirakl
  // ============================================
  async syncProducts() {
    console.log('\n🔄 Starting offer sync (Shopify → Mirakl)...');
    try {
      const products = await this.shopify.getProducts();
      console.log(`📦 Found ${products.length} products in Shopify`);

      if (products.length === 0) {
        console.log('⚠️  No products to sync');
        return { success: true, count: 0 };
      }

      // Convert Shopify products to Mirakl OFFER CSV format
      const csvLines = ['sku;product-id;product-id-type;price;quantity;state;description'];
      
      for (const product of products) {
        for (const variant of product.variants) {
          const sku = variant.sku || `SHOPIFY-${variant.id}`;
          const line = [
            sku,                                          // sku: your offer SKU
            sku,                                          // product-id: link to product
            'SHOP_SKU',                                   // product-id-type
            variant.price,                                // price
            variant.inventory_quantity || 0,              // quantity
            '11',                                         // state: 11 = new
            `"${this.cleanDescription(product.body_html)}"` // description
          ].join(';');
          csvLines.push(line);
        }
      }

      const csvContent = csvLines.join('\n');
      const result = await this.mirakl.importProducts(csvContent);
      
      console.log(`✅ Offers imported to Mirakl successfully!`);
      console.log(`   Import ID: ${result.import_id}`);
      this.syncState.lastProductSync = new Date().toISOString();
      this.saveSyncState();
      
      return result;
    } catch (error) {
      console.error('❌ Offer sync failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  // ============================================
  // INVENTORY SYNC: Shopify → Mirakl
  // ============================================
  async syncInventory() {
    console.log('\n🔄 Starting inventory sync (Shopify → Mirakl)...');
    try {
      const products = await this.shopify.getProducts();
      const inventoryItemIds = products.flatMap(p => 
        p.variants.map(v => v.inventory_item_id)
      );

      if (inventoryItemIds.length === 0) {
        console.log('⚠️  No inventory items to sync');
        return { success: true, count: 0 };
      }

      const inventoryLevels = await this.shopify.getInventoryLevels(inventoryItemIds);
      console.log(`📊 Found ${inventoryLevels.length} inventory levels`);

      // Create inventory map
      const inventoryMap = {};
      inventoryLevels.forEach(level => {
        inventoryMap[level.inventory_item_id] = level.available || 0;
      });

      // Build CSV for Mirakl offers update
      const csvLines = ['sku;quantity'];
      
      for (const product of products) {
        for (const variant of product.variants) {
          const quantity = inventoryMap[variant.inventory_item_id] || 0;
          csvLines.push(`${variant.sku || variant.id};${quantity}`);
        }
      }

      const csvContent = csvLines.join('\n');
      const result = await this.mirakl.updateOffers(csvContent);
      
      console.log(`✅ Inventory synced to Mirakl successfully!`);
      console.log(`   Import ID: ${result.import_id}`);
      this.syncState.lastInventorySync = new Date().toISOString();
      this.saveSyncState();
      
      return result;
    } catch (error) {
      console.error('❌ Inventory sync failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  // ============================================
  // ORDER SYNC: Mirakl → Shopify
  // ============================================
  async syncOrders() {
    console.log('\n🔄 Starting order sync (Mirakl → Shopify)...');
    try {
      const orders = await this.mirakl.getOrders(this.syncState.lastOrderSync);
      console.log(`📋 Found ${orders.length} orders from Mirakl`);

      if (orders.length === 0) {
        console.log('ℹ️  No new orders to sync');
        return { success: true, createdCount: 0 };
      }

      let createdCount = 0;
      for (const miraklOrder of orders) {
        // Skip if already processed
        if (this.syncState.processedOrders.includes(miraklOrder.order_id)) {
          console.log(`⏭️  Skipping already processed order: ${miraklOrder.order_id}`);
          continue;
        }

        // Create order in Shopify
        const shopifyOrderData = {
          email: miraklOrder.customer?.email || 'noemail@mirakl.order',
          line_items: miraklOrder.order_lines.map(line => ({
            title: line.offer?.product_title || 'Product',
            price: line.price,
            quantity: line.quantity,
            sku: line.offer?.sku
          })),
          shipping_address: this.convertAddress(miraklOrder.shipping_address),
          billing_address: this.convertAddress(miraklOrder.billing_address),
          financial_status: 'paid',
          tags: `Mirakl,Order-${miraklOrder.order_id}`,
          note: `Mirakl Order ID: ${miraklOrder.order_id}`
        };

        const shopifyOrder = await this.shopify.createOrder(shopifyOrderData);
        console.log(`✅ Created Shopify order #${shopifyOrder.order_number} from Mirakl order ${miraklOrder.order_id}`);
        
        this.syncState.processedOrders.push(miraklOrder.order_id);
        createdCount++;
      }

      this.syncState.lastOrderSync = new Date().toISOString();
      this.saveSyncState();
      
      console.log(`✅ Order sync complete. Created ${createdCount} new orders.`);
      return { success: true, createdCount };
    } catch (error) {
      console.error('❌ Order sync failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  // ============================================
  // TRACKING SYNC: Shopify → Mirakl
  // ============================================
  async syncTracking() {
    console.log('\n🔄 Starting tracking sync (Shopify → Mirakl)...');
    try {
      // Get recent Shopify orders with Mirakl tag
      const orders = await this.shopify.getOrdersSince();
      const miraklOrders = orders.filter(o => 
        o.tags && o.tags.includes('Mirakl') && o.fulfillment_status === 'fulfilled'
      );

      console.log(`📦 Found ${miraklOrders.length} fulfilled Mirakl orders`);

      if (miraklOrders.length === 0) {
        console.log('ℹ️  No fulfilled orders with tracking to sync');
        return { success: true, updatedCount: 0 };
      }

      let updatedCount = 0;
      for (const order of miraklOrders) {
        // Extract Mirakl order ID from tags or notes
        const miraklOrderId = this.extractMiraklOrderId(order);
        if (!miraklOrderId) {
          console.log(`⚠️  Could not extract Mirakl order ID from Shopify order ${order.order_number}`);
          continue;
        }

        // Get fulfillments with tracking
        const fulfillments = await this.shopify.getFulfillments(order.id);
        
        for (const fulfillment of fulfillments) {
          if (fulfillment.tracking_number) {
            await this.mirakl.updateTracking(miraklOrderId, {
              carrier_code: fulfillment.tracking_company || 'OTHER',
              tracking_number: fulfillment.tracking_number,
              tracking_url: fulfillment.tracking_url
            });
            
            console.log(`✅ Updated tracking for Mirakl order ${miraklOrderId}`);
            console.log(`   Tracking: ${fulfillment.tracking_number}`);
            updatedCount++;
          }
        }
      }

      this.syncState.lastTrackingSync = new Date().toISOString();
      this.saveSyncState();
      
      console.log(`✅ Tracking sync complete. Updated ${updatedCount} orders.`);
      return { success: true, updatedCount };
    } catch (error) {
      console.error('❌ Tracking sync failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  // ============================================
  // HELPER METHODS
  // ============================================
  cleanDescription(html) {
    if (!html) return '';
    return html.replace(/<[^>]*>/g, '').replace(/"/g, '""').substring(0, 500);
  }

  convertAddress(address) {
    if (!address) return null;
    return {
      first_name: address.firstname,
      last_name: address.lastname,
      address1: address.street_1,
      address2: address.street_2,
      city: address.city,
      province: address.state,
      country: address.country_iso_code,
      zip: address.zip_code,
      phone: address.phone
    };
  }

  extractMiraklOrderId(shopifyOrder) {
    // Try to extract from note first
    if (shopifyOrder.note) {
      const match = shopifyOrder.note.match(/Mirakl Order ID: ([^\s]+)/);
      if (match) return match[1];
    }
    
    // Try to extract from tags
    if (shopifyOrder.tags) {
      const match = shopifyOrder.tags.match(/Order-([^\s,]+)/);
      if (match) return match[1];
    }
    
    return null;
  }
}

// ============================================
// APPLICATION STARTUP
// ============================================
async function main() {
  console.log('\n');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🚀 SHOPIFY-MIRAKL INTEGRATION');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📅 Started at: ${new Date().toLocaleString()}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Validate configuration
  if (config.shopify.storeName === 'YOUR_STORE_NAME' || 
      config.mirakl.apiUrl === 'https://YOUR_INSTANCE.mirakl.net' ||
      config.shopify.storeName.includes('YOUR') ||
      config.mirakl.apiKey.includes('YOUR')) {
    console.error('❌ CONFIGURATION ERROR!');
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error('Please set your API credentials:');
    console.error('');
    console.error('Option 1 - Environment Variables (Railway/Heroku):');
    console.error('  Set these in your hosting dashboard:');
    console.error('  - SHOPIFY_STORE_NAME');
    console.error('  - SHOPIFY_ACCESS_TOKEN');
    console.error('  - MIRAKL_API_URL');
    console.error('  - MIRAKL_API_KEY');
    console.error('  - MIRAKL_SHOP_ID');
    console.error('');
    console.error('Option 2 - Direct in Code:');
    console.error('  Edit the config section in index.js');
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    process.exit(1);
  }

  console.log('✅ Configuration validated');
  console.log(`   Shopify Store: ${config.shopify.storeName}.myshopify.com`);
  console.log(`   Mirakl URL: ${config.mirakl.apiUrl}`);
  console.log(`   Shop ID: ${config.mirakl.shopId}\n`);

  // Initialize clients
  const shopifyClient = new ShopifyClient(config.shopify);
  const miraklClient = new MiraklClient(config.mirakl);
  const syncManager = new SyncManager(shopifyClient, miraklClient);

  // Schedule automated syncs
  if (config.sync.enabled) {
    console.log('⏰ Scheduling automated syncs...');
    console.log(`   Products:  ${config.sync.schedules.products}`);
    console.log(`   Inventory: ${config.sync.schedules.inventory}`);
    console.log(`   Orders:    ${config.sync.schedules.orders}`);
    console.log(`   Tracking:  ${config.sync.schedules.tracking}`);
    
    cron.schedule(config.sync.schedules.products, async () => {
      console.log('\n[SCHEDULED] Product sync triggered');
      await syncManager.syncProducts();
    });

    cron.schedule(config.sync.schedules.inventory, async () => {
      console.log('\n[SCHEDULED] Inventory sync triggered');
      await syncManager.syncInventory();
    });

    cron.schedule(config.sync.schedules.orders, async () => {
      console.log('\n[SCHEDULED] Order sync triggered');
      await syncManager.syncOrders();
    });

    cron.schedule(config.sync.schedules.tracking, async () => {
      console.log('\n[SCHEDULED] Tracking sync triggered');
      await syncManager.syncTracking();
    });

    console.log('✅ All scheduled tasks configured\n');
  }

  // Run initial sync
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🔄 RUNNING INITIAL SYNC');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  
  try {
    await syncManager.syncProducts();
    await syncManager.syncInventory();
    await syncManager.syncOrders();
    await syncManager.syncTracking();
    
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ INITIAL SYNC COMPLETE!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🎉 Integration is now running!');
    console.log('💡 Syncs will run automatically on schedule');
    console.log('🛑 Press Ctrl+C to stop');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  } catch (error) {
    console.error('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error('❌ INITIAL SYNC FAILED');
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error('Error:', error.message);
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  }
}

// Keep the process running
process.on('SIGINT', () => {
  console.log('\n\n🛑 Shutting down gracefully...');
  console.log('👋 Integration stopped. Goodbye!\n');
  process.exit(0);
});

// Start the application
if (require.main === module) {
  main().catch(error => {
    console.error('💥 Fatal error:', error);
    process.exit(1);
  });
}

module.exports = { ShopifyClient, MiraklClient, SyncManager };

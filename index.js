// ============================================
// SHOPIFY-MIRAKL INTEGRATION (SIMPLIFIED)
// ============================================
// ONLY: Orders (Mirakl → Shopify) + Inventory (Shopify → Mirakl)

const axios = require('axios');
const FormData = require('form-data');
const cron = require('node-cron');
const fs = require('fs');

// ============================================
// CONFIGURATION
// ============================================
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
      inventory: process.env.SCHEDULE_INVENTORY || '*/30 * * * *',  // Every 30 minutes
      orders: process.env.SCHEDULE_ORDERS || '*/15 * * * *'         // Every 15 minutes
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
      lastInventorySync: null,
      lastOrderSync: null,
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
  // INVENTORY SYNC: Shopify → Mirakl
  // Creates FULL OFFERS with all required fields
  // ============================================
  async syncInventory() {
    console.log('\n🔄 Starting inventory/offers sync (Shopify → Mirakl)...');
    try {
      const products = await this.shopify.getProducts();
      
      if (products.length === 0) {
        console.log('⚠️  No products to sync');
        return { success: true, count: 0 };
      }

      // Get inventory item IDs
      const inventoryItemIds = products.flatMap(p => 
        p.variants.map(v => v.inventory_item_id)
      );

      const inventoryLevels = await this.shopify.getInventoryLevels(inventoryItemIds);
      console.log(`📊 Found ${inventoryLevels.length} inventory levels`);

      // Create inventory map
      const inventoryMap = {};
      inventoryLevels.forEach(level => {
        inventoryMap[level.inventory_item_id] = Math.max(0, level.available || 0); // Ensure non-negative
      });

      // Build COMPLETE OFFER CSV (not just quantities!)
      // This creates/updates offers with full data
      const csvLines = ['sku;product-id;product-id-type;price;quantity;state;description;leadtime-to-ship'];
      
      for (const product of products) {
        for (const variant of product.variants) {
          const sku = variant.sku || variant.barcode || `SHOPIFY-${variant.id}`;
          const quantity = Math.max(0, inventoryMap[variant.inventory_item_id] || 0); // Ensure non-negative
          const price = variant.price || '0.00';
          const description = this.cleanDescription(product.body_html || product.title);
          
          const line = [
            sku,                    // sku
            sku,                    // product-id (same as sku)
            'SHOP_SKU',             // product-id-type
            price,                  // price
            quantity,               // quantity (non-negative)
            '11',                   // state (11 = new)
            `"${description}"`,     // description
            '2'                     // leadtime-to-ship (2 days)
          ].join(';');
          csvLines.push(line);
        }
      }

      const csvContent = csvLines.join('\n');
      const result = await this.mirakl.updateOffers(csvContent);
      
      console.log(`✅ Offers synced to Mirakl successfully!`);
      console.log(`   Import ID: ${result.import_id}`);
      console.log(`   ${products.flatMap(p => p.variants).length} offers processed`);
      
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
  // HELPER METHODS
  // ============================================
  cleanDescription(html) {
    if (!html) return 'Product description';
    return html.replace(/<[^>]*>/g, '').replace(/"/g, '""').substring(0, 200);
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
}

// ============================================
// APPLICATION STARTUP
// ============================================
async function main() {
  console.log('\n');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🚀 SHOPIFY-MIRAKL INTEGRATION (SIMPLIFIED)');
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
    console.error('Please set your API credentials in environment variables!');
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
    console.log(`   Inventory: ${config.sync.schedules.inventory} (Shopify → Mirakl)`);
    console.log(`   Orders:    ${config.sync.schedules.orders} (Mirakl → Shopify)`);
    
    // Inventory sync (every 30 minutes)
    cron.schedule(config.sync.schedules.inventory, async () => {
      console.log('\n[SCHEDULED] Inventory sync triggered');
      await syncManager.syncInventory();
    });

    // Orders sync (every 15 minutes)
    cron.schedule(config.sync.schedules.orders, async () => {
      console.log('\n[SCHEDULED] Order sync triggered');
      await syncManager.syncOrders();
    });

    console.log('✅ Scheduled tasks configured\n');
  }

  // Run initial sync
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🔄 RUNNING INITIAL SYNC');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  
  try {
    await syncManager.syncInventory();
    await syncManager.syncOrders();
    
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ INITIAL SYNC COMPLETE!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🎉 Integration is now running!');
    console.log('💡 Syncs:');
    console.log('   • Inventory updates every 30 minutes');
    console.log('   • Orders imported every 15 minutes');
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

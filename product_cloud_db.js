/**
 * FreeSite SaaS — Universal Product Management Database Schema
 * Handles Categories, Products, Images, API Applications, Webhooks, and Audit Logs
 */

const { pool } = require('./database');

async function initializeProductCloudSystem() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ১. ক্যাটাগরি টেবিল (Hierarchical / Parent-Child)
    await client.query(`
      CREATE TABLE IF NOT EXISTS product_categories (
        id SERIAL PRIMARY KEY,
        name VARCHAR(150) NOT NULL,
        slug VARCHAR(180) UNIQUE NOT NULL,
        description TEXT,
        image_url TEXT,
        parent_id INT REFERENCES product_categories(id) ON DELETE SET NULL,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_categories_slug ON product_categories(slug);
    `);

    // ২. প্রোডাক্ট টেবিল (Universal Full-spec)
    await client.query(`
      CREATE TABLE IF NOT EXISTS universal_products (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        slug VARCHAR(280) UNIQUE NOT NULL,
        description TEXT,
        main_image TEXT,
        category_id INT REFERENCES product_categories(id) ON DELETE SET NULL,
        subcategory_id INT REFERENCES product_categories(id) ON DELETE SET NULL,
        regular_price NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
        discount_price NUMERIC(12, 2) DEFAULT 0.00,
        currency VARCHAR(10) DEFAULT 'BDT',
        stock_quantity INT DEFAULT 0,
        stock_status VARCHAR(30) DEFAULT 'in_stock', -- in_stock, out_of_stock, backorder
        sku VARCHAR(100) UNIQUE,
        brand VARCHAR(100),
        specifications JSONB DEFAULT '{}'::jsonb,
        variations JSONB DEFAULT '[]'::jsonb,
        tags TEXT[] DEFAULT ARRAY[]::TEXT[],
        product_url TEXT,
        status VARCHAR(30) DEFAULT 'published', -- published, draft, archived
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_products_sku ON universal_products(sku);
      CREATE INDEX IF NOT EXISTS idx_products_category ON universal_products(category_id);
      CREATE INDEX IF NOT EXISTS idx_products_status ON universal_products(status);
    `);

    // ৩. প্রোডাক্ট ইমেজ গ্যালারি (Cloudinary)
    await client.query(`
      CREATE TABLE IF NOT EXISTS product_gallery_images (
        id SERIAL PRIMARY KEY,
        product_id INT NOT NULL REFERENCES universal_products(id) ON DELETE CASCADE,
        image_url TEXT NOT NULL,
        thumbnail_url TEXT,
        public_id VARCHAR(255) NOT NULL,
        is_main BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_gallery_product ON product_gallery_images(product_id);
    `);

    // ৪. এক্সটার্নাল এপিআই অ্যাপ্লিকেশন ও সিক্রেট কি টেবিল
    await client.query(`
      CREATE TABLE IF NOT EXISTS api_applications (
        id SERIAL PRIMARY KEY,
        app_name VARCHAR(120) NOT NULL,
        app_id VARCHAR(64) UNIQUE NOT NULL,
        api_key_hash VARCHAR(128) NOT NULL,
        secret_key_hash VARCHAR(128) NOT NULL,
        permissions TEXT[] DEFAULT ARRAY['products:read', 'products:write', 'categories:read', 'inventory:read']::TEXT[],
        status VARCHAR(20) DEFAULT 'active', -- active, revoked, suspended
        request_count BIGINT DEFAULT 0,
        last_access_at TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_api_app_id ON api_applications(app_id);
    `);

    // ৫. ওয়েবহুক কনফিগারেশন টেবিল
    await client.query(`
      CREATE TABLE IF NOT EXISTS api_webhooks (
        id SERIAL PRIMARY KEY,
        app_id VARCHAR(64) REFERENCES api_applications(app_id) ON DELETE CASCADE,
        target_url TEXT NOT NULL,
        secret VARCHAR(128) NOT NULL,
        subscribed_events TEXT[] NOT NULL,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // ৬. ওয়েবহুক ডেলিভারি লগ ও রিট্রাই ট্র্যাকার
    await client.query(`
      CREATE TABLE IF NOT EXISTS webhook_delivery_logs (
        id SERIAL PRIMARY KEY,
        webhook_id INT REFERENCES api_webhooks(id) ON DELETE CASCADE,
        event_name VARCHAR(60) NOT NULL,
        payload JSONB NOT NULL,
        response_code INT,
        response_body TEXT,
        success BOOLEAN DEFAULT FALSE,
        attempt_count INT DEFAULT 1,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // ৭. এপিআই অডিট লগ (Security & Analytics)
    await client.query(`
      CREATE TABLE IF NOT EXISTS api_audit_logs (
        id BIGSERIAL PRIMARY KEY,
        app_id VARCHAR(64),
        endpoint VARCHAR(255) NOT NULL,
        http_method VARCHAR(10) NOT NULL,
        status_code INT NOT NULL,
        ip_address VARCHAR(45),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_audit_created ON api_audit_logs(created_at);
    `);

    await client.query('COMMIT');
    console.log('[INFO]: ✅ Universal Product Management Cloud DB Initialized!');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[ERROR]: Failed to init product cloud db:', err.message);
  } finally {
    client.release();
  }
}

module.exports = {
  initializeProductCloudSystem
};

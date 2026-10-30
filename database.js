/**
 * FreeSite Builder & WhatsApp Bot SaaS — Database Engine
 * Automatic Schema Initialization & Baileys DB Session Storage
 */

const { Pool } = require('pg');

// Neon.tech ডাটাবেজ পুল কানেকশন
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

pool.on('connect', () => {
  console.log('[INFO]: ✅ Neon PostgreSQL Database Connected Successfully!');
});

pool.on('error', (err) => {
  console.error('[ERROR]: Database Pool Error:', err.message);
});

/**
 * সার্ভার চালু হলে সব টেবিল স্বয়ংক্রিয়ভাবে তৈরি হবে
 */
async function initializeDatabase() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ১. ইউজার টেবিল
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(50) DEFAULT 'user', -- 'admin' অথবা 'user'
        plan VARCHAR(50) DEFAULT 'free', -- 'free' অথবা 'premium'
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // ২. সার্ভার ম্যানেজমেন্ট টেবিল (অ্যাডমিন যত খুশি রেন্ডার সার্ভার যোগ করতে ও বট ট্রান্সফার করতে পারবে)
    await client.query(`
      CREATE TABLE IF NOT EXISTS worker_servers (
        id SERIAL PRIMARY KEY,
        server_name VARCHAR(100) NOT NULL,
        server_url VARCHAR(255) UNIQUE NOT NULL,
        is_active BOOLEAN DEFAULT TRUE,
        max_capacity INT DEFAULT 10,
        current_load INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // ৩. হোয়াটসঅ্যাপ বট টেবিল (প্রতিটি ইউজারের আলাদা বট কনফিগ)
    await client.query(`
      CREATE TABLE IF NOT EXISTS whatsapp_bots (
        id SERIAL PRIMARY KEY,
        user_id INT REFERENCES users(id) ON DELETE CASCADE,
        server_id INT REFERENCES worker_servers(id) ON DELETE SET NULL,
        bot_name VARCHAR(100) NOT NULL,
        phone_number VARCHAR(30),
        website_url VARCHAR(255),
        system_prompt TEXT,
        addressing_style VARCHAR(50) DEFAULT 'ভাইয়া',
        delivery_inside INT DEFAULT 70,
        delivery_outside INT DEFAULT 130,
        admin_phone VARCHAR(30),
        telegram_token VARCHAR(255),
        telegram_chat_id VARCHAR(100),
        status VARCHAR(50) DEFAULT 'DISCONNECTED', -- 'CONNECTED', 'DISCONNECTED', 'PAIRING'
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // ৪. হোয়াটসঅ্যাপ সেশন টেবিল (Render রিস্টার্ট হলেও WhatsApp সেশন আজীবন ডাটাবেজে অক্ষত থাকবে)
    await client.query(`
      CREATE TABLE IF NOT EXISTS whatsapp_sessions (
        bot_id INT NOT NULL,
        session_key VARCHAR(255) NOT NULL,
        session_data TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (bot_id, session_key)
      );
    `);

    // ৫. ওয়েবসাইট পণ্য ক্যাটালগ টেবিল (স্ক্র্যাপ করা বা আপলোড করা প্রোডাক্ট)
    await client.query(`
      CREATE TABLE IF NOT EXISTS bot_products (
        id SERIAL PRIMARY KEY,
        bot_id INT REFERENCES whatsapp_bots(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        price NUMERIC(10, 2) DEFAULT 0,
        category VARCHAR(100),
        in_stock BOOLEAN DEFAULT TRUE,
        buy_link TEXT,
        description TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // ৬. ওয়েবসাইট হোস্ট ও সাবডোমেইন টেবিল (৩টি ডোমেইনের জন্য)
    await client.query(`
      CREATE TABLE IF NOT EXISTS hosted_websites (
        id SERIAL PRIMARY KEY,
        user_id INT REFERENCES users(id) ON DELETE CASCADE,
        subdomain VARCHAR(100) NOT NULL,
        base_domain VARCHAR(100) NOT NULL, -- 'sojib.qd.je', 'sojib.de5.net', 'sojub.cc.cd'
        html_content TEXT,
        is_published BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (subdomain, base_domain)
      );
    `);

    await client.query('COMMIT');
    console.log('[INFO]: ✅ All SaaS Database Tables Initialized Automatically!');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[ERROR]: Failed to initialize database tables:', err.message);
  } finally {
    client.release();
  }
}

module.exports = {
  pool,
  initializeDatabase
};

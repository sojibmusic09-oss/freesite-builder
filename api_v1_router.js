/**
 * FreeSite SaaS — Universal Product Management REST API v1
 * Base Path: /api/v1/
 */

const express = require('express');
const crypto = require('crypto');
const { pool } = require('./database');
const { uploadProductImage, deleteCloudImage } = require('./cloud_storage');
const { triggerWebhookEvent } = require('./webhook_dispatcher');

const router = express.Router();

// ================= সিকিউরিটি মিডলওয়্যার: API Key & Secret Validation =================
async function authenticateApiKey(req, res, next) {
  if (req.path === '/health' || req.path === '/docs' || req.path === '/openapi.json') {
    return next();
  }

  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  const secretKey = req.headers['x-secret-key'] || req.query.secret_key;

  if (!apiKey || !secretKey) {
    return res.status(401).json({
      success: false,
      error: 'Authentication Required',
      message: 'Missing X-API-KEY or X-SECRET-KEY header'
    });
  }

  try {
    const keyHash = crypto.createHash('sha256').update(String(apiKey).trim()).digest('hex');
    const secretHash = crypto.createHash('sha256').update(String(secretKey).trim()).digest('hex');

    const appRes = await pool.query(
      `SELECT * FROM api_applications 
       WHERE api_key_hash = $1 AND secret_key_hash = $2 AND status = 'active'`,
      [keyHash, secretHash]
    );

    if (appRes.rows.length === 0) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden',
        message: 'Invalid, revoked or suspended API Credentials'
      });
    }

    req.apiApp = appRes.rows[0];

    pool.query(
      `UPDATE api_applications 
       SET request_count = request_count + 1, last_access_at = NOW() 
       WHERE id = $1`,
      [req.apiApp.id]
    ).catch(() => {});

    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    res.on('finish', () => {
      pool.query(
        `INSERT INTO api_audit_logs (app_id, endpoint, http_method, status_code, ip_address)
         VALUES ($1, $2, $3, $4, $5)`,
        [req.apiApp.app_id, req.originalUrl, req.method, res.statusCode, clientIp]
      ).catch(() => {});
    });

    next();
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Auth DB Error: ' + err.message });
  }
}

router.use(authenticateApiKey);

// ১. হেলথ চেক
router.get('/health', async (req, res) => {
  let dbStatus = 'healthy';
  try { await pool.query('SELECT 1'); } catch (e) { dbStatus = 'unreachable'; }
  res.json({
    status: 'ok',
    version: 'v1.0.0',
    service: 'FreeSite Universal Product Management Cloud API',
    database: dbStatus,
    timestamp: new Date().toISOString()
  });
});

// ২. প্রোডাক্ট তালিকা (Pagination, Filter, Sort)
router.get('/products', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const offset = (page - 1) * limit;

    const { category_id, status, min_price, max_price, stock_status, sort } = req.query;

    const conditions = [];
    const values = [];
    let valIdx = 1;

    if (category_id) { conditions.push(`category_id = $${valIdx++}`); values.push(parseInt(category_id, 10)); }
    if (status) { conditions.push(`status = $${valIdx++}`); values.push(status); }
    if (stock_status) { conditions.push(`stock_status = $${valIdx++}`); values.push(stock_status); }
    if (min_price) { conditions.push(`regular_price >= $${valIdx++}`); values.push(parseFloat(min_price)); }
    if (max_price) { conditions.push(`regular_price <= $${valIdx++}`); values.push(parseFloat(max_price)); }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    let orderBy = 'ORDER BY created_at DESC';
    if (sort === 'price_asc') orderBy = 'ORDER BY regular_price ASC';
    else if (sort === 'price_desc') orderBy = 'ORDER BY regular_price DESC';
    else if (sort === 'name_asc') orderBy = 'ORDER BY name ASC';

    const countRes = await pool.query(`SELECT COUNT(*) FROM universal_products ${whereClause}`, values);
    const totalRecords = parseInt(countRes.rows[0].count, 10);

    const query = `
      SELECT p.*, c.name as category_name
      FROM universal_products p
      LEFT JOIN product_categories c ON p.category_id = c.id
      ${whereClause}
      ${orderBy}
      LIMIT $${valIdx++} OFFSET $${valIdx++}
    `;
    values.push(limit, offset);

    const productsRes = await pool.query(query, values);

    res.json({
      success: true,
      data: productsRes.rows,
      meta: {
        total: totalRecords,
        page: page,
        limit: limit,
        total_pages: Math.ceil(totalRecords / limit)
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ৩. নির্দিষ্ট প্রোডাক্টের বিস্তারিত
router.get('/products/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const product = await pool.query(
      `SELECT p.*, c.name as category_name 
       FROM universal_products p
       LEFT JOIN product_categories c ON p.category_id = c.id
       WHERE p.id = $1`,
      [id]
    );

    if (product.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    const gallery = await pool.query(
      `SELECT id, image_url, thumbnail_url, public_id, is_main, created_at 
       FROM product_gallery_images 
       WHERE product_id = $1 ORDER BY is_main DESC, id ASC`,
      [id]
    );

    res.json({
      success: true,
      data: { ...product.rows[0], images: gallery.rows }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ৪. প্রোডাক্ট সার্চ
router.get('/products/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).json({ success: false, message: 'Query parameter q is required' });

    const searchRes = await pool.query(
      `SELECT id, name, slug, regular_price, discount_price, main_image, stock_status, brand, sku 
       FROM universal_products 
       WHERE name ILIKE $1 OR description ILIKE $1 OR brand ILIKE $1 OR sku ILIKE $1
       ORDER BY created_at DESC LIMIT 30`,
      [`%${q}%`]
    );

    res.json({ success: true, count: searchRes.rows.length, data: searchRes.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ৫. নতুন প্রোডাক্ট তৈরি
router.post('/products', async (req, res) => {
  try {
    const {
      name, description, main_image, category_id, subcategory_id,
      regular_price, discount_price, currency, stock_quantity,
      sku, brand, specifications, variations, tags, product_url, status
    } = req.body;

    if (!name || regular_price === undefined) {
      return res.status(400).json({ success: false, message: 'name and regular_price are mandatory' });
    }

    const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + Math.floor(1000 + Math.random() * 9000);
    const stockStatus = parseInt(stock_quantity, 10) > 0 ? 'in_stock' : 'out_of_stock';

    const insertRes = await pool.query(
      `INSERT INTO universal_products (
        name, slug, description, main_image, category_id, subcategory_id,
        regular_price, discount_price, currency, stock_quantity, stock_status,
        sku, brand, specifications, variations, tags, product_url, status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      RETURNING *`,
      [
        name, slug, description || '', main_image || '', category_id || null, subcategory_id || null,
        regular_price, discount_price || 0.00, currency || 'BDT', stock_quantity || 0, stockStatus,
        sku || `SKU-${Date.now()}`, brand || '', JSON.stringify(specifications || {}),
        JSON.stringify(variations || []), tags || [], product_url || '', status || 'published'
      ]
    );

    const createdProduct = insertRes.rows[0];
    triggerWebhookEvent('product.created', createdProduct);

    res.status(201).json({ success: true, message: 'Product created successfully', data: createdProduct });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ৬. প্রোডাক্ট আপডেট
router.put('/products/:id', updateProductHandler);
router.patch('/products/:id', updateProductHandler);

async function updateProductHandler(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await pool.query('SELECT * FROM universal_products WHERE id = $1', [id]);
    if (existing.rows.length === 0) return res.status(404).json({ success: false, message: 'Product not found' });

    const prev = existing.rows[0];
    const b = req.body;

    const name = b.name !== undefined ? b.name : prev.name;
    const description = b.description !== undefined ? b.description : prev.description;
    const main_image = b.main_image !== undefined ? b.main_image : prev.main_image;
    const category_id = b.category_id !== undefined ? b.category_id : prev.category_id;
    const subcategory_id = b.subcategory_id !== undefined ? b.subcategory_id : prev.subcategory_id;
    const regular_price = b.regular_price !== undefined ? b.regular_price : prev.regular_price;
    const discount_price = b.discount_price !== undefined ? b.discount_price : prev.discount_price;
    const currency = b.currency !== undefined ? b.currency : prev.currency;
    const stock_quantity = b.stock_quantity !== undefined ? b.stock_quantity : prev.stock_quantity;
    const stock_status = b.stock_status !== undefined ? b.stock_status : (parseInt(stock_quantity, 10) > 0 ? 'in_stock' : 'out_of_stock');
    const sku = b.sku !== undefined ? b.sku : prev.sku;
    const brand = b.brand !== undefined ? b.brand : prev.brand;
    const specifications = b.specifications !== undefined ? JSON.stringify(b.specifications) : prev.specifications;
    const variations = b.variations !== undefined ? JSON.stringify(b.variations) : prev.variations;
    const tags = b.tags !== undefined ? b.tags : prev.tags;
    const product_url = b.product_url !== undefined ? b.product_url : prev.product_url;
    const status = b.status !== undefined ? b.status : prev.status;

    const updatedRes = await pool.query(
      `UPDATE universal_products SET
        name = $1, description = $2, main_image = $3, category_id = $4, subcategory_id = $5,
        regular_price = $6, discount_price = $7, currency = $8, stock_quantity = $9,
        stock_status = $10, sku = $11, brand = $12, specifications = $13, variations = $14,
        tags = $15, product_url = $16, status = $17, updated_at = NOW()
       WHERE id = $18 RETURNING *`,
      [
        name, description, main_image, category_id, subcategory_id,
        regular_price, discount_price, currency, stock_quantity,
        stock_status, sku, brand, specifications, variations,
        tags, product_url, status, id
      ]
    );

    const updated = updatedRes.rows[0];
    triggerWebhookEvent('product.updated', updated);
    if (prev.regular_price !== updated.regular_price) triggerWebhookEvent('product.price_updated', updated);
    if (prev.stock_quantity !== updated.stock_quantity) triggerWebhookEvent('product.stock_updated', updated);

    res.json({ success: true, message: 'Product updated successfully', data: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

// ৭. প্রোডাক্ট ডিলিট
router.delete('/products/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const images = await pool.query('SELECT public_id FROM product_gallery_images WHERE product_id = $1', [id]);

    for (const img of images.rows) {
      await deleteCloudImage(img.public_id);
    }

    const delRes = await pool.query('DELETE FROM universal_products WHERE id = $1 RETURNING *', [id]);
    if (delRes.rows.length === 0) return res.status(404).json({ success: false, message: 'Product not found' });

    triggerWebhookEvent('product.deleted', { id });
    res.json({ success: true, message: `Product #${id} and associated cloud images deleted successfully` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ৮. ইমেজ ক্লাউড আপলোড
router.post('/products/:id/images', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { image_base64, is_main } = req.body;
    if (!image_base64) return res.status(400).json({ success: false, message: 'image_base64 is required' });

    const cloudImg = await uploadProductImage(image_base64, `products/prod_${id}`);

    const isMainBool = Boolean(is_main);
    if (isMainBool) {
      await pool.query('UPDATE product_gallery_images SET is_main = FALSE WHERE product_id = $1', [id]);
      await pool.query('UPDATE universal_products SET main_image = $1 WHERE id = $2', [cloudImg.imageUrl, id]);
    }

    const imgRes = await pool.query(
      `INSERT INTO product_gallery_images (product_id, image_url, thumbnail_url, public_id, is_main)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [id, cloudImg.imageUrl, cloudImg.thumbnailUrl, cloudImg.publicId, isMainBool]
    );

    res.status(201).json({ success: true, message: 'Image uploaded to Cloudinary', data: imgRes.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ৯. ইমেজ ডিলিট
router.delete('/products/:id/images/:image_id', async (req, res) => {
  try {
    const image_id = parseInt(req.params.image_id, 10);
    const img = await pool.query('SELECT public_id FROM product_gallery_images WHERE id = $1', [image_id]);
    if (img.rows.length === 0) return res.status(404).json({ success: false, message: 'Image not found' });

    await deleteCloudImage(img.rows[0].public_id);
    await pool.query('DELETE FROM product_gallery_images WHERE id = $1', [image_id]);

    res.json({ success: true, message: 'Image deleted from Cloudinary & database' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ১০. ক্যাটাগরি রাউটস
router.get('/categories', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.*, COUNT(p.id) as product_count 
      FROM product_categories c
      LEFT JOIN universal_products p ON c.id = p.category_id
      GROUP BY c.id ORDER BY c.id ASC
    `);
    res.json({ success: true, count: result.rows.length, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/categories', async (req, res) => {
  try {
    const { name, description, image_url, parent_id } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Category name is required' });

    const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + Math.floor(100 + Math.random() * 900);
    const catRes = await pool.query(
      `INSERT INTO product_categories (name, slug, description, image_url, parent_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name, slug, description || '', image_url || '', parent_id || null]
    );

    triggerWebhookEvent('category.created', catRes.rows[0]);
    res.status(201).json({ success: true, data: catRes.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/categories/:id/products', async (req, res) => {
  try {
    const catId = parseInt(req.params.id, 10);
    const products = await pool.query('SELECT * FROM universal_products WHERE category_id = $1 ORDER BY created_at DESC', [catId]);
    res.json({ success: true, count: products.rows.length, data: products.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ১১. ইনভেন্টরি ট্র্যাকিং
router.get('/inventory', async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT 
        COUNT(*) as total_items,
        SUM(stock_quantity) as total_units,
        COUNT(CASE WHEN stock_quantity <= 5 THEN 1 END) as low_stock_count,
        COUNT(CASE WHEN stock_status = 'out_of_stock' OR stock_quantity = 0 THEN 1 END) as out_of_stock_count
      FROM universal_products
    `);

    const lowStockItems = await pool.query(
      `SELECT id, name, sku, stock_quantity, stock_status, regular_price 
       FROM universal_products 
       WHERE stock_quantity <= 5 ORDER BY stock_quantity ASC LIMIT 20`
    );

    res.json({ success: true, summary: stats.rows[0], low_stock_alerts: lowStockItems.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ১২. ইন্টিগ্রেশন ইনফো
router.get('/integrations', async (req, res) => {
  try {
    const apps = await pool.query(`SELECT id, app_name, app_id, permissions, status, request_count, last_access_at, created_at FROM api_applications ORDER BY id DESC`);
    res.json({ success: true, connected_applications: apps.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ১৩. OpenAPI 3.0 ডকুমেন্টেশন
router.get('/openapi.json', (req, res) => {
  const protocol = req.protocol;
  const host = req.get('host');
  res.json({
    openapi: '3.0.3',
    info: {
      title: 'FreeSite Universal Product Management API',
      version: 'v1.0.0',
      description: 'Production REST API for Mobile Apps, Admin Portals & Cloud SaaS'
    },
    servers: [{ url: `${protocol}://${host}/api/v1` }],
    components: {
      securitySchemes: {
        ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-KEY' },
        SecretKeyAuth: { type: 'apiKey', in: 'header', name: 'X-SECRET-KEY' }
      }
    },
    security: [{ ApiKeyAuth: [], SecretKeyAuth: [] }]
  });
});

router.get('/docs', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>API Documentation — FreeSite Cloud v1</title>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="https://unpkg.com/rapidoc/dist/rapidoc.min.css"/>
  <script type="module" src="https://unpkg.com/rapidoc/dist/rapidoc-min.js"></script>
</head>
<body style="margin:0; font-family:sans-serif;">
  <rapi-doc 
    spec-url="/api/v1/openapi.json" 
    theme="light" 
    primary-color="#059669" 
    render-style="read" 
    show-header="true"
    allow-server-selection="false"
  ></rapi-doc>
</body>
</html>`);
});

module.exports = router;

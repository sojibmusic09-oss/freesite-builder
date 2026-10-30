/**
 * FreeSite SaaS — Cloud Storage Manager (Cloudinary Object Storage)
 * Automatic WebP conversion, auto-optimization, and thumbnail generation.
 */

const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'demo',
  api_key: process.env.CLOUDINARY_API_KEY || '',
  api_secret: process.env.CLOUDINARY_API_SECRET || '',
  secure: true
});

/**
 * Upload Base64 or Binary Data URI to Cloudinary
 */
async function uploadProductImage(fileDataUri, folder = 'freesite_products') {
  if (!fileDataUri) throw new Error('No image payload provided');

  // সিকিউরিটি ভ্যালিডেশন: শুধুমাত্র ইমেজ মাইম টাইপ অনুমতি
  if (!fileDataUri.startsWith('data:image/') && !fileDataUri.startsWith('http')) {
    throw new Error('Invalid file format. Only image formats (PNG, JPG, WEBP, JPEG) are allowed.');
  }

  const result = await cloudinary.uploader.upload(fileDataUri, {
    folder: folder,
    resource_type: 'image',
    format: 'webp',
    transformation: [
      { quality: 'auto:good' },
      { fetch_format: 'auto' }
    ]
  });

  // থাম্বনেইল URL জেনারেশন
  const thumbnailUrl = cloudinary.url(result.public_id, {
    width: 300,
    height: 300,
    crop: 'fill',
    quality: 'auto',
    format: 'webp'
  });

  return {
    imageUrl: result.secure_url,
    thumbnailUrl: thumbnailUrl,
    publicId: result.public_id,
    width: result.width,
    height: result.height,
    format: result.format
  };
}

/**
 * Delete image from Cloudinary permanently
 */
async function deleteCloudImage(publicId) {
  if (!publicId) return false;
  try {
    const res = await cloudinary.uploader.destroy(publicId);
    return res.result === 'ok';
  } catch (err) {
    console.error('[STORAGE]: Failed to delete cloud image:', err.message);
    return false;
  }
}

module.exports = {
  uploadProductImage,
  deleteCloudImage
};

import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';

const router = Router();

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

// GET /api/products — list with filters
router.get('/', async (req, res, next) => {
  try {
    const supabase = getSupabase();
    const {
      category,
      strap_type,
      min_price,
      max_price,
      search,
      sort = 'newest',
      featured,
      page = 1,
      limit = 12,
    } = req.query;

    let query = supabase
      .from('watch-products')
      .select('*', { count: 'exact' })
      .eq('is_active', true);

    if (category) query = query.eq('category', category);
    if (strap_type) query = query.eq('strap_type', strap_type);
    if (min_price) query = query.gte('price', Number(min_price));
    if (max_price) query = query.lte('price', Number(max_price));
    if (featured === 'true') query = query.eq('is_featured', true);
    if (search) {
      query = query.or(`name.ilike.%${search}%,description.ilike.%${search}%`);
    }

    switch (sort) {
      case 'price_asc':
        query = query.order('price', { ascending: true });
        break;
      case 'price_desc':
        query = query.order('price', { ascending: false });
        break;
      case 'popularity':
        query = query.order('is_featured', { ascending: false }).order('created_at', { ascending: false });
        break;
      case 'newest':
      default:
        query = query.order('created_at', { ascending: false });
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(48, Math.max(1, parseInt(limit, 10) || 12));
    const from = (pageNum - 1) * limitNum;
    const to = from + limitNum - 1;

    query = query.range(from, to);

    const { data, error, count } = await query;
    if (error) throw error;

    res.json({
      products: data || [],
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limitNum),
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/products/:slugOrId
router.get('/:slugOrId', async (req, res, next) => {
  try {
    const supabase = getSupabase();
    const { slugOrId } = req.params;

    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(slugOrId);

    let query = supabase.from('watch-products').select('*').eq('is_active', true);
    if (isUuid) {
      query = query.eq('id', slugOrId);
    } else {
      query = query.eq('slug', slugOrId);
    }

    const { data, error } = await query.maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Product not found' });

    // Related products (same category, exclude self)
    const { data: related } = await supabase
      .from('watch-products')
      .select('id, name, slug, price, image_urls, category, strap_type')
      .eq('is_active', true)
      .eq('category', data.category)
      .neq('id', data.id)
      .limit(4);

    res.json({ product: data, related: related || [] });
  } catch (err) {
    next(err);
  }
});

export default router;

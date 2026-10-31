import { z } from 'zod';

export function validate(schema) {
  return (req, res, next) => {
    try {
      const parsed = schema.parse(req.body);
      req.validated = parsed;
      next();
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({
          error: 'Validation failed',
          details: err.errors.map((e) => ({ path: e.path.join('.'), message: e.message })),
        });
      }
      next(err);
    }
  };
}

export const createOrderSchema = z.object({
  customer_name: z.string().min(2).max(120),
  customer_email: z.string().email().max(180),
  customer_phone: z.string().min(7).max(30).optional().nullable(),
  shipping_address: z.string().min(5).max(300),
  city: z.string().min(2).max(100),
  postal_code: z.string().max(20).optional().nullable(),
  country: z.string().min(2).max(100).default('Pakistan'),
  payment_method: z.enum(['cod', 'card', 'bank_transfer']).default('cod'),
  items: z
    .array(
      z.object({
        product_id: z.string().uuid(),
        quantity: z.number().int().min(1).max(20),
      })
    )
    .min(1)
    .max(30),
  idempotency_key: z.string().min(8).max(64).optional(),
});

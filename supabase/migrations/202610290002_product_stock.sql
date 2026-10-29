-- Existing products retain unknown availability until an admin enters a count.
begin;
alter table public.product add column if not exists stock_quantity integer
  check (stock_quantity >= 0 and stock_quantity <= 100000000);
commit;

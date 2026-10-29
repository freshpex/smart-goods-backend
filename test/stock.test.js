import { test } from "node:test";
import assert from "node:assert/strict";
import { productSchema, publicProduct } from "../src/validation.js";
const base = { name: "Product", category: "Gaming", price: 10 };
test("stock accepts nonnegative integer quantities, zero and an unknown value", () => {
  for (const stock_quantity of [null, 0, 3, 500]) {
    assert.equal(
      productSchema.parse({ ...base, stock_quantity }).stock_quantity,
      stock_quantity,
    );
    assert.equal(
      publicProduct({ ...base, stock_quantity }).stock_quantity,
      stock_quantity,
    );
  }
  assert.equal(productSchema.parse(base).stock_quantity, null);
});
test("stock rejects negative, fractional, oversized and string quantities", () => {
  for (const stock_quantity of [-1, 1.5, 100000001, "5"])
    assert.equal(
      productSchema.safeParse({ ...base, stock_quantity }).success,
      false,
    );
});

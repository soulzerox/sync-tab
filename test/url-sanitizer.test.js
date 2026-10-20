/**
 * url-sanitizer unit tests (node --test) — Normalized URL เป็นฐาน dedupe ของคลัง (SOT §2)
 * จุดสำคัญ v3.0.1: fragment (#hash) ไม่ใช่ส่วนของ "หน้า" — ต้องถูกตัดทิ้งเสมอ
 * (เว็บเดียวกัน/หน้าเดียวกัน เปิดพร้อมเครื่องหมาย # ต่างกันถือเป็น record เดียวกัน)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeUrl, isIgnoredUrl } from "../background/url-sanitizer.js";

test("normalizeUrl: ตัด fragment #hash — hash ต่างกัน = key เดียวกัน (กรณีจริงที่ผู้ใช้พบ)", () => {
  const base = "https://novelkingdom.co/writer";
  assert.equal(normalizeUrl("https://novelkingdom.co/writer#%E0%B8%AA%E0%B8%96%E0%B8%B4%E0%B8%95%E0%B8%B4"), base);
  assert.equal(normalizeUrl("https://novelkingdom.co/writer#สถิติรายได้"), base);
  assert.equal(normalizeUrl("https://x.example/#top"), "https://x.example");
});

test("normalizeUrl: host ตัวเล็ก + ตัด trailing slash + idempotent (พยากรณ์ normalize ซ้ำไม่เปลี่ยน)", () => {
  assert.equal(normalizeUrl("HTTP://X.example/"), "http://x.example");
  assert.equal(normalizeUrl("https://a.example/x/"), "https://a.example/x");
  const once = normalizeUrl("https://b.example/p/#ref");
  assert.equal(normalizeUrl(once), once);
});

test("normalizeUrl: query คงอยู่ทั้งหมด (เฉพาะ hash ถูกตัด)", () => {
  assert.equal(normalizeUrl("https://a.example/list?page=2#next"), "https://a.example/list?page=2");
});

test("normalizeUrl: ไม่ใช่ URL → คืนค่าที่ trim แล้ว; ค่าไม่ใช่ string → ''", () => {
  assert.equal(normalizeUrl(" notaurl "), "notaurl");
  assert.equal(normalizeUrl(null), "");
  assert.equal(normalizeUrl(42), "");
});

test("isIgnoredUrl: URL เข้าระบบ/ privileged (L1) — edge://* กับ about:blank ไม่ถูกจับ", () => {
  assert.equal(isIgnoredUrl("edge://settings/"), true);
  assert.equal(isIgnoredUrl("about:blank"), true);
  assert.equal(isIgnoredUrl("https://ok.example/page"), false);
});

test("normalizeUrl (v3.1): ตัด tracking params — __cf_chl*, utm_*, fbclid ฯลฯ Token ต่างกันถือเป็นหน้าเดียวกัน", () => {
  assert.equal(
    normalizeUrl("https://twkan.com/book/68028.html?__cf_chl_rt_tk=AAA-111zz"),
    "https://twkan.com/book/68028.html"
  );
  assert.equal(
    normalizeUrl("https://site.com/p?utm_source=x&utm_medium=y&page=2"),
    "https://site.com/p?page=2",
    "param ธุรกิจจริง (page=2) ถูกคงไว้"
  );
  assert.equal(normalizeUrl("https://s.com/?fbclid=zz"), "https://s.com");
  assert.equal(
    normalizeUrl("https://s.com/a?__cf_chl_tk=1") === normalizeUrl("https://s.com/a?__cf_chl_tk=2"),
    true,
    "หน้าเดียวกัน ต่างเทียบ Token → key เดียว"
  );
});

test("normalizeUrl (v3.4): เรียง param — ลำดับต่างกัน = key เดียวกัน (dedupe แท็บหลับซ้ำ)", () => {
  assert.equal(
    normalizeUrl("https://s.com/p?b=2&a=1"),
    normalizeUrl("https://s.com/p?a=1&b=2"),
    "?a=1&b=2 กับ ?b=2&a=1 เป็นหน้าเดียวกัน"
  );
});

/**
 * URL Sanitizer & Normalizer Module
 * Pure Functions for URL validation, normalization, and security filtering.
 */

import {
  IGNORED_URL_PREFIXES,
  TRACKING_PARAM_PREFIXES,
  THRESHOLDS
} from "../shared/constants.js";

/**
 * Checks whether a URL should be ignored from syncing (privileged, internal, or empty).
 * @param {string | undefined | null} url
 * @returns {boolean}
 */
export function isIgnoredUrl(url) {
  if (!url || typeof url !== "string") return true;
  const trimmed = url.trim();
  if (trimmed === "" || trimmed === "about:blank") return true;

  return IGNORED_URL_PREFIXES.some(prefix => trimmed.toLowerCase().startsWith(prefix));
}

/** Normalize a domain or URL entered in the exclusion list to a hostname. */
export function normalizeBlacklistDomain(domain) {
  if (typeof domain !== "string") return "";
  let value = domain.trim().toLowerCase();
  if (!value) return "";
  value = value.replace(/^\*\./, "").replace(/^\./, "");
  try {
    const parsed = new URL(value.includes("://") ? value : `https://${value}`);
    if (parsed.username || parsed.password) return "";
    return parsed.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
}

/** Returns true when a URL's hostname matches an excluded domain or its subdomain. */
export function isBlacklistedUrl(url, blacklistDomains = []) {
  if (typeof url !== "string" || !Array.isArray(blacklistDomains) || blacklistDomains.length === 0) return false;
  let hostname;
  try {
    hostname = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return false;
  }
  return blacklistDomains.some(entry => {
    const domain = normalizeBlacklistDomain(entry);
    return domain && (hostname === domain || hostname.endsWith(`.${domain}`));
  });
}

/**
 * Normalizes a URL for comparison and storage.
 * Standardizes protocol, hostname lowercase, strips trailing slash, strips URL fragment (#hash),
 * and (legacy path) marketing tracking parameters.
 * v3 dedupe rule: หน้าเดียวกันเปิดพร้อม fragment ต่างกัน (เช่น #สถิติรายได้) = record เดียวกัน
 * @param {string} url
 * @param {boolean} [stripTracking=true]
 * @returns {string}
 */
export function normalizeUrl(url, stripTracking = true) {
  if (!url || typeof url !== "string") return "";
  const trimmed = url.trim();

  try {
    const parsed = new URL(trimmed);

    // ตัด fragment #hash ทิ้งเสมอ — ฐาน dedupe คือ "หน้า" ไม่ใช่ตำแหน่ง scroll และแท็กฝั่งเว็บ
    parsed.hash = "";

    if (stripTracking && parsed.search) {
      const searchParams = new URLSearchParams(parsed.search);
      const keysToDelete = [];

      for (const key of searchParams.keys()) {
        const lowerKey = key.toLowerCase();
        if (TRACKING_PARAM_PREFIXES.some(prefix => lowerKey.startsWith(prefix))) {
          keysToDelete.push(key);
        }
      }

      for (const key of keysToDelete) {
        searchParams.delete(key);
      }
      // v3.4 — เรียง param ให้ ?a=1&b=2 กับ ?b=2&a=1 เป็น key เดียวกัน (dedupe แท็บหลับซ้ำ)
      searchParams.sort();

      parsed.search = searchParams.toString() ? `?${searchParams.toString()}` : "";
    }

    let normalized = parsed.toString();
    // Normalize trailing slash
    if (normalized.endsWith("/") && (parsed.pathname === "/" || parsed.pathname.endsWith("/"))) {
      normalized = normalized.slice(0, -1);
    }

    return normalized;
  } catch {
    return trimmed;
  }
}

/**
 * Removes repeated normalized URLs while preserving the first tab and its metadata.
 * Remaining tabs are reindexed to match their new order.
 * @param {Array<{url?: string}>} tabs
 * @param {boolean} [stripTracking=true]
 * @returns {Array}
 */
export function dedupeTabsByUrl(tabs = [], stripTracking = true) {
  const seen = new Set();
  const uniqueTabs = [];

  for (const tab of tabs) {
    if (!tab?.url) {
      uniqueTabs.push({ ...tab, index: uniqueTabs.length });
      continue;
    }

    const normalized = normalizeUrl(tab.url, stripTracking);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    uniqueTabs.push({ ...tab, index: uniqueTabs.length });
  }

  return uniqueTabs;
}

/**
 * Derives a useful title when a browser tab has not received its document title yet.
 * Only web URLs are used; internal/invalid URLs keep the generic fallback.
 * @param {string | undefined | null} url
 * @returns {string}
 */
export function titleFromUrl(url) {
  if (typeof url !== "string" || !url.trim()) return "Untitled";
  try {
    const parsed = new URL(url.trim());
    if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) return "Untitled";
    const hostname = parsed.hostname.replace(/^www\./i, "");
    const segment = parsed.pathname.split("/").filter(Boolean).pop();
    if (!segment) return hostname;
    let readableSegment = segment;
    try {
      readableSegment = decodeURIComponent(segment);
    } catch {
      // Keep the encoded segment when it is not valid percent-encoding.
    }
    readableSegment = readableSegment.replace(/[-_]+/g, " ").trim();
    if (!readableSegment || readableSegment.toLowerCase() === "index") return hostname;
    return `${hostname} — ${readableSegment}`;
  } catch {
    return "Untitled";
  }
}

/**
 * Sanitizes page title to prevent memory/buffer overflows in Native Messaging.
 * Empty/generic browser placeholders use a URL-derived title when available.
 * @param {string | undefined | null} title
 * @param {number} [maxLength=THRESHOLDS.MAX_TITLE_LENGTH]
 * @param {string} [fallbackUrl]
 * @returns {string}
 */
export function sanitizeTitle(title, maxLength = THRESHOLDS.MAX_TITLE_LENGTH, fallbackUrl = null) {
  const trimmed = typeof title === "string" ? title.trim() : "";
  const usableTitle = trimmed && trimmed.toLowerCase() !== "untitled"
    ? trimmed
    : titleFromUrl(fallbackUrl);
  if (usableTitle.length > maxLength) {
    return usableTitle.slice(0, maxLength) + "…";
  }
  return usableTitle || "Untitled";
}

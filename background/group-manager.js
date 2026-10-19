/**
 * Group Manager Module
 * Handles Tab Group data sanitization and scoped Chromium color validations.
 */

import {
  CHROMIUM_TAB_GROUP_COLORS,
  DEFAULT_TAB_GROUP_COLOR
} from "../shared/constants.js";

/**
 * Sanitizes and validates a Tab Group color against Chromium 9-color enum.
 * @param {string | undefined | null} color
 * @returns {import("../shared/types.js").TabGroupColor}
 */
export function sanitizeGroupColor(color) {
  if (!color || typeof color !== "string") {
    return DEFAULT_TAB_GROUP_COLOR;
  }
  const lower = color.toLowerCase();
  if (CHROMIUM_TAB_GROUP_COLORS.includes(/** @type {any} */ (lower))) {
    return /** @type {import("../shared/types.js").TabGroupColor} */ (lower);
  }
  return DEFAULT_TAB_GROUP_COLOR;
}

/**
 * Converts a raw Chrome TabGroup object into a clean TabGroupData object.
 * @param {chrome.tabGroups.TabGroup | null | undefined} group
 * @returns {import("../shared/types.js").TabGroupData | undefined}
 */
export function extractGroupData(group) {
  if (!group) return undefined;
  return {
    title: (group.title || "").trim(),
    color: sanitizeGroupColor(group.color),
    collapsed: Boolean(group.collapsed)
  };
}

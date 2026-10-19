/**
 * Groups snapshot tabs with the same logical group identity.
 * Named groups use a trimmed, case-insensitive title; unnamed groups use color.
 * @param {Array<{group?: {title?: string, color?: string}}>} tabs
 * @returns {{groups: Array<{key: string, title: string, color: string, tabs: Array}>, ungrouped: Array}}
 */
export function normalizeGroupTitle(title) {
  return String(title || "").trim().toLowerCase();
}

export function getTabGroupKey(group = {}) {
  const normalizedTitle = normalizeGroupTitle(group.title);
  return normalizedTitle
    ? `name:${normalizedTitle}`
    : `color:${String(group.color || "grey").toLowerCase()}`;
}

export function clusterTabsByGroup(tabs = []) {
  const groupsMap = new Map();
  const ungrouped = [];

  for (const tab of tabs) {
    if (tab.group && (tab.group.title || tab.group.color)) {
      const color = String(tab.group.color || "grey").toLowerCase();
      const title = String(tab.group.title || "").trim();
      const groupKey = getTabGroupKey({ title, color });

      if (!groupsMap.has(groupKey)) {
        groupsMap.set(groupKey, {
          key: groupKey,
          title: title || "Untitled Group",
          color,
          tabs: []
        });
      }
      groupsMap.get(groupKey).tabs.push(tab);
    } else {
      ungrouped.push(tab);
    }
  }

  return { groups: Array.from(groupsMap.values()), ungrouped };
}

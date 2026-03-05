import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs) {
  return twMerge(clsx(inputs))
}

/** Строит иерархию из плоского списка по parent_id */
export function buildTree(items, parentId = null) {
  return items
    .filter(i => (i.parent_id ?? null) === parentId)
    .map(item => ({
      ...item,
      children: buildTree(items, item.id),
    }))
}

/** Разворачивает дерево в плоский список с depth для отступа. expandedIds — Set id раскрытых узлов (если null — все раскрыты) */
export function flattenTree(tree, depth = 0, expandedIds = null) {
  const result = []
  for (const node of tree) {
    result.push({ ...node, depth })
    const showChildren = node.children?.length && (expandedIds === null || expandedIds.has(node.id))
    if (showChildren) {
      result.push(...flattenTree(node.children, depth + 1, expandedIds))
    }
  }
  return result
}

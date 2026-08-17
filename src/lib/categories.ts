/** Sentinel for channels with no category tags. Not a real categories.id. */
export const UNCATEGORIZED_CATEGORY_ID = '__uncategorized__';

export function isUncategorizedFilter(categoryId: string | null | undefined): boolean {
	return categoryId === UNCATEGORIZED_CATEGORY_ID;
}

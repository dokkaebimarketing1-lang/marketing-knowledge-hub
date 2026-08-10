export interface VisibilityData {
	status?: string;
	draft?: boolean;
}

export function isVisibleDoc<T extends VisibilityData>(data: T): boolean {
	return data.draft !== true && data.status === 'active';
}

export function isVisibleTerm<T extends VisibilityData>(data: T): boolean {
	return data.draft !== true && data.status === 'active';
}
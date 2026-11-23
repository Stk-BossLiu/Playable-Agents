export type DependencyState = 'ready' | 'missing' | 'not-configured' | 'error' | 'optional' | 'not-required';

export interface DependencyItem {
  id: string;
  label: string;
  required: boolean;
  state: DependencyState;
  version?: string;
  path?: string;
  message?: string;
  action?: string;
}

export interface DependenciesDTO {
  checkedAt: string;
  items: DependencyItem[];
}

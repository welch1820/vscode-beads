export interface TeamMemberProvider {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  fetchMembers(rootPath: string): Promise<string[]>;
}

export interface TeamMemberCache {
  members: string[];
  source: string;
  fetchedAt: string;
}

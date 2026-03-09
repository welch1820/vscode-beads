import { exec } from "child_process";
import { TeamMemberProvider } from "./types";

interface GitLabMember {
  id: number;
  username: string;
  name: string;
  state: string;
}

interface GitLabUser {
  id: number;
  username: string;
  public_email?: string;
  email?: string;
}

export interface GitLabConfig {
  url: string;
  token: string;
}

export class GitLabTeamProvider implements TeamMemberProvider {
  readonly name = "gitlab";

  constructor(private getConfig: () => GitLabConfig) {}

  async isAvailable(): Promise<boolean> {
    const { url, token } = this.getConfig();
    return !!(url && token);
  }

  async fetchMembers(rootPath: string): Promise<string[]> {
    const { url, token } = this.getConfig();
    if (!url || !token) {
      return [];
    }

    const projectPath = await this.resolveProjectPath(rootPath, url);
    if (!projectPath) {
      return [];
    }

    const members = await this.fetchProjectMembers(url, token, projectPath);
    return this.resolveEmails(url, token, members);
  }

  private async resolveProjectPath(rootPath: string, gitlabUrl: string): Promise<string | null> {
    let remoteUrl: string;
    try {
      remoteUrl = await new Promise<string>((resolve, reject) => {
        exec("git remote get-url origin", { cwd: rootPath, timeout: 5000 }, (err, stdout) => {
          if (err) reject(err);
          else resolve(stdout.trim());
        });
      });
    } catch {
      return null;
    }

    // Parse project path from remote URL
    // SSH:   git@gitlab.com:group/subgroup/project.git
    // HTTPS: https://gitlab.com/group/subgroup/project.git
    const hostname = new URL(gitlabUrl).hostname;

    // SSH format
    const sshMatch = remoteUrl.match(new RegExp(`${hostname}[:/](.+?)(?:\\.git)?$`));
    if (sshMatch) {
      return sshMatch[1];
    }

    // HTTPS format
    const httpsMatch = remoteUrl.match(new RegExp(`${hostname}/(.+?)(?:\\.git)?$`));
    if (httpsMatch) {
      return httpsMatch[1];
    }

    return null;
  }

  private async fetchProjectMembers(
    url: string,
    token: string,
    projectPath: string
  ): Promise<GitLabMember[]> {
    const encoded = encodeURIComponent(projectPath);
    const response = await fetch(
      `${url}/api/v4/projects/${encoded}/members/all?per_page=100`,
      { headers: { "PRIVATE-TOKEN": token } }
    );

    if (!response.ok) {
      throw new Error(`GitLab API error: ${response.status} ${response.statusText}`);
    }

    const members = (await response.json()) as GitLabMember[];
    return members.filter((m) => m.state === "active");
  }

  private async resolveEmails(
    url: string,
    token: string,
    members: GitLabMember[]
  ): Promise<string[]> {
    const results: string[] = [];

    // Fetch user profiles in parallel to get emails where available
    const profiles = await Promise.allSettled(
      members.map((m) =>
        fetch(`${url}/api/v4/users/${m.id}`, {
          headers: { "PRIVATE-TOKEN": token },
        }).then((r) => (r.ok ? (r.json() as Promise<GitLabUser>) : null))
      )
    );

    for (let i = 0; i < members.length; i++) {
      const profile = profiles[i];
      if (profile.status === "fulfilled" && profile.value) {
        const email = profile.value.public_email || profile.value.email;
        results.push(email || members[i].username);
      } else {
        results.push(members[i].username);
      }
    }

    return results;
  }
}

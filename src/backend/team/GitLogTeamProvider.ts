import { exec } from "child_process";
import { TeamMemberProvider } from "./types";

export class GitLogTeamProvider implements TeamMemberProvider {
  readonly name = "git-log";

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async fetchMembers(rootPath: string): Promise<string[]> {
    const output = await new Promise<string>((resolve, reject) => {
      exec(
        "git log --format=%aE --all | sort -u",
        { cwd: rootPath, timeout: 30000 },
        (err, stdout) => {
          if (err) {
            reject(err);
          } else {
            resolve(stdout);
          }
        }
      );
    });

    const members: string[] = [];
    for (const line of output.split("\n")) {
      const trimmed = line.trim().toLowerCase();
      if (trimmed) {
        members.push(trimmed);
      }
    }
    return members;
  }
}

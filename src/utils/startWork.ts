
import * as vscode from "vscode";
import { execFile } from "child_process";
import { BeadsCLIClient } from "../backend/BeadsCLIClient";
import { Logger } from "./logger";

/**
 * After a bead transitions from open → in_progress, offer to create/switch to
 * a feature branch named feature/BUG-<bugzillaId>.
 */
export async function handleStartWork(
  beadId: string,
  client: BeadsCLIClient,
  logger: Logger
): Promise<void> {
  try {
    // Fetch full bead to get metadata.bugzilla_id
    const issue = await client.show(beadId);
    if (!issue) {
      return;
    }

    const bugzillaId = issue.metadata?.bugzilla_id != null
      ? Number(issue.metadata.bugzilla_id)
      : undefined;

    if (!bugzillaId) {
      return; // No Bugzilla ID — nothing to offer
    }

    const branchName = `feature/BUG-${bugzillaId}`;

    // Check if branch exists locally or remotely
    const localExists = await gitBranchExists(branchName);
    const remoteExists = localExists ? false : await gitRemoteBranchExists(branchName);

    let action: string | undefined;
    if (localExists) {
      action = await vscode.window.showInformationMessage(
        `Switch to branch \`${branchName}\`?`,
        "Switch Branch",
        "Skip"
      );
    } else if (remoteExists) {
      action = await vscode.window.showInformationMessage(
        `Check out remote branch \`${branchName}\`?`,
        "Check Out",
        "Skip"
      );
    } else {
      action = await vscode.window.showInformationMessage(
        `Create branch \`${branchName}\`?`,
        "Create Branch",
        "Skip"
      );
    }

    if (!action || action === "Skip") {
      return;
    }

    // Execute the git command
    let gitArgs: string[];
    if (localExists) {
      gitArgs = ["checkout", branchName];
    } else if (remoteExists) {
      gitArgs = ["checkout", "-b", branchName, `origin/${branchName}`];
    } else {
      gitArgs = ["checkout", "-b", branchName];
    }

    await execGit(gitArgs);
    logger.info(`Switched to branch ${branchName}`);

    // Auto-assign bead to current user
    const config = vscode.workspace.getConfiguration("beads");
    const userId = config.get<string>("userId", "") || process.env.USER || process.env.USERNAME || "unknown";
    try {
      await client.update({ id: beadId, assignee: userId });
    } catch (err) {
      logger.warn(`Failed to auto-assign bead: ${err}`);
    }
  } catch (err) {
    logger.error(`handleStartWork failed: ${err}`);
  }
}

function gitBranchExists(branchName: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("git", ["branch", "--list", branchName], (err, stdout) => {
      if (err) {
        resolve(false);
        return;
      }
      resolve(stdout.trim().length > 0);
    });
  });
}

function gitRemoteBranchExists(branchName: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("git", ["branch", "-r", "--list", `*/${branchName}`], (err, stdout) => {
      if (err) {
        resolve(false);
        return;
      }
      resolve(stdout.trim().length > 0);
    });
  });
}

function execGit(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message));
        return;
      }
      resolve(stdout);
    });
  });
}

import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { TeamMemberProvider, TeamMemberCache } from "./types";
import { Logger } from "../../utils/logger";

const CACHE_FILE = "team-members.json";
const CACHE_TTL_HOURS = 24;

export class TeamMemberService {
  private providers: TeamMemberProvider[] = [];
  private memoryCache: string[] | null = null;
  private log: Logger;

  constructor(logger: Logger) {
    this.log = logger.child("TeamMemberService");
  }

  addProvider(provider: TeamMemberProvider): void {
    this.providers.push(provider);
  }

  invalidate(): void {
    this.memoryCache = null;
  }

  async getMembers(beadsDir: string, rootPath: string): Promise<string[]> {
    if (this.memoryCache) {
      return this.memoryCache;
    }

    // Try persistent cache first
    const cached = this.readCache(beadsDir);
    if (cached) {
      this.log.info(`Using cached team members (${cached.members.length}, source: ${cached.source})`);
      this.memoryCache = cached.members;
      return cached.members;
    }

    // Try providers in order — first available one wins
    const allMembers = new Set<string>();
    let source = "none";

    for (const provider of this.providers) {
      try {
        const available = await provider.isAvailable();
        if (!available) {
          this.log.debug(`Provider ${provider.name}: not available, skipping`);
          continue;
        }

        this.log.info(`Fetching team members from ${provider.name}...`);
        const members = await provider.fetchMembers(rootPath);
        if (members.length > 0) {
          for (const m of members) {
            allMembers.add(m);
          }
          source = provider.name;
          this.log.info(`${provider.name}: found ${members.length} members`);
          break; // Use first successful provider
        }
      } catch (err) {
        this.log.warn(`Provider ${provider.name} failed: ${err}`);
      }
    }

    // Always merge in bd config team.members
    const configMembers = await this.fetchConfigMembers(rootPath);
    for (const m of configMembers) {
      allMembers.add(m);
    }
    if (configMembers.length > 0 && source === "none") {
      source = "config";
    }

    const result = Array.from(allMembers).sort();
    this.memoryCache = result;

    // Persist to disk
    this.writeCache(beadsDir, result, source);
    this.log.info(`Team members resolved: ${result.length} (source: ${source})`);

    return result;
  }

  private readCache(beadsDir: string): TeamMemberCache | null {
    try {
      const cachePath = path.join(beadsDir, CACHE_FILE);
      const raw = fs.readFileSync(cachePath, "utf-8");
      const cache = JSON.parse(raw) as TeamMemberCache;

      const age = Date.now() - new Date(cache.fetchedAt).getTime();
      if (age > CACHE_TTL_HOURS * 60 * 60 * 1000) {
        this.log.debug("Cache expired");
        return null;
      }

      return cache;
    } catch {
      return null;
    }
  }

  private writeCache(beadsDir: string, members: string[], source: string): void {
    try {
      const cachePath = path.join(beadsDir, CACHE_FILE);
      const cache: TeamMemberCache = {
        members,
        source,
        fetchedAt: new Date().toISOString(),
      };
      fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2) + "\n");
    } catch (err) {
      this.log.warn(`Failed to write team member cache: ${err}`);
    }
  }

  private async fetchConfigMembers(rootPath: string): Promise<string[]> {
    try {
      const output = await new Promise<string>((resolve, reject) => {
        execFile("bd", ["config", "get", "team.members"], { cwd: rootPath, timeout: 5000 }, (err, stdout) => {
          if (err) reject(err);
          else resolve(stdout);
        });
      });
      const trimmed = output.trim();
      if (!trimmed || trimmed.includes("(not set)")) return [];
      return trimmed.split(",").map((m) => m.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }
}

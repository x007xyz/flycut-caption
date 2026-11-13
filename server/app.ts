import { Context, type Plugin } from '@deepseek-ai/cordis';
import type { HostConfig } from './services';
import { bootProfile, collectLayers, resolveProfile, type ProfileLayer, type ResolvedProfile } from './profile';

export interface CreateHostOptions {
  /** Base profile name (default `FLYCUT_PROFILE` or `desktop`). */
  profile?: string;
  /** Extra patch layers applied after the home and environment layers. */
  patches?: ProfileLayer[];
  /** Replaces the built-in ASR Provider rows (tests and embedders). */
  providers?: Plugin[];
  /** In-process plugins appended before the gateway. */
  plugins?: Plugin[];
  gateway?: boolean;
}

/** Resolves the layered profile without booting it (`--dump-config`). */
export async function resolveHostProfile(config: HostConfig, options: CreateHostOptions = {}): Promise<ResolvedProfile> {
  const profile = resolveProfile(options.profile ?? process.env.FLYCUT_PROFILE ?? 'desktop', await collectLayers(config.home, options.patches), config.home);
  const inline = (id: string, plugin: Plugin) => ({ id, plugin, source: 'builtin' as const, provides: [] as string[] });
  if (options.providers) {
    const first = profile.rows.findIndex(row => row.id.startsWith('asr-'));
    profile.rows = profile.rows.filter(row => !row.id.startsWith('asr-'));
    profile.rows.splice(first < 0 ? profile.rows.length : first, 0, ...options.providers.map((plugin, index) => inline(`inline-provider-${index}`, plugin)));
  }
  if (options.gateway === false) profile.rows = profile.rows.filter(row => row.id !== 'gateway');
  if (options.plugins?.length) {
    const gateway = profile.rows.findIndex(row => row.id === 'gateway');
    profile.rows.splice(gateway < 0 ? profile.rows.length : gateway, 0, ...options.plugins.map((plugin, index) => inline(`inline-plugin-${index}`, plugin)));
  }
  return profile;
}

export async function createHost(config: HostConfig, options: CreateHostOptions = {}) {
  const ctx = new Context();
  try {
    const profile = await resolveHostProfile(config, options);
    ctx.provide('hostConfig', { ...config, profileName: profile.name });
    await bootProfile(ctx, profile);
    return ctx;
  } catch (error) { await ctx.fiber.dispose(); throw error; }
}

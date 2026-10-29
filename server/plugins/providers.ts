import type { Context } from '@deepseek-ai/cordis';
import type { AsrProvider } from '../../shared/protocol';
import type { ProviderPackage } from '../../src/types/provider';
import type { ProviderRegistry } from '../services';

export const providerRegistryPlugin = { name: 'flycut-provider-registry', inject: ['rpc'], apply(ctx: Context) {
  const providers = new Map<string, AsrProvider>();
  const packages = new Map<string, ProviderPackage>();
  const registry: ProviderRegistry = {
    register(provider) {
      if (providers.has(provider.id)) throw new Error(`Duplicate Provider: ${provider.id}`);
      providers.set(provider.id, provider);
      return () => { if (providers.get(provider.id) === provider) providers.delete(provider.id); };
    },
    get(id) { const provider = providers.get(id); if (!provider) throw new Error(`Provider unavailable: ${id}`); return provider; },
    list: () => [...providers.values()].map(({ id, name }) => ({ id, name })),
    describe(pkg) {
      if (packages.has(pkg.id)) throw new Error(`Duplicate Provider package: ${pkg.id}`);
      packages.set(pkg.id, pkg);
      return () => { if (packages.get(pkg.id) === pkg) packages.delete(pkg.id); };
    },
    catalog: () => [...packages.values()].map(pkg => structuredClone(pkg)),
  };
  ctx.provide('providers', registry);
  ctx.effect(() => ctx.rpc.register('providers.list', undefined, () => registry.list()));
  ctx.effect(() => ctx.rpc.register('providers.catalog', undefined, () => registry.catalog()));
} };

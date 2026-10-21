// Estende o app.json. O deploy da web numa subpasta (GitHub Pages em /<repo>) define EXPO_BASE_URL.
import type { ConfigContext, ExpoConfig } from 'expo/config';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...(config as ExpoConfig),
  experiments: { ...config.experiments, baseUrl: process.env.EXPO_BASE_URL ?? '' },
});

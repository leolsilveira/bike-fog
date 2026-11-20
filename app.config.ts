// Estende o app.json. O deploy da web numa subpasta (GitHub Pages em /<repo>) define EXPO_BASE_URL.
// Também habilita o ciclo de vida UIScene no iOS (obrigatório ao compilar com Xcode 27 / iOS 27 SDK).
import type { ConfigContext, ExpoConfig } from 'expo/config';
import { withAppDelegate, withInfoPlist } from 'expo/config-plugins';

function withIosSceneLifecycle(config: ExpoConfig): ExpoConfig {
  config = withInfoPlist(config, (c) => {
    c.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: 'Default Configuration',
            UISceneDelegateClassName: 'EXExpoAppSceneDelegate',
          },
        ],
      },
    };
    return c;
  });

  config = withAppDelegate(config, (c) => {
    if (c.modResults.language === 'swift') {
      let src = c.modResults.contents;
      if (!src.includes('ExpoReactNativeFactoryProvider')) {
        src = src.replace(
          'class AppDelegate: ExpoAppDelegate {',
          'class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {',
        );
      }
      src = src.replace(
        /#if os\(iOS\) \|\| os\(tvOS\)\n\s*window = UIWindow\(frame: UIScreen\.main\.bounds\)\n\s*factory\.startReactNative\([\s\S]*?launchOptions: launchOptions\)\n#endif\n?/,
        '',
      );
      c.modResults.contents = src;
    }
    return c;
  });

  return config;
}

export default ({ config }: ConfigContext): ExpoConfig =>
  withIosSceneLifecycle({
    ...(config as ExpoConfig),
    experiments: { ...config.experiments, baseUrl: process.env.EXPO_BASE_URL ?? '' },
  });

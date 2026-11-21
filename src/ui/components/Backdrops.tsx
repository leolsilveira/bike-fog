// Fundos em degradê das telas de título e criação, desenhados com SVG (o RN do Expo SDK 57 não tem
// `backgroundImage`). Ficam por trás do conteúdo, sem receber toques.
import { View } from 'react-native';
import Svg, { Defs, Ellipse, LinearGradient, RadialGradient, Rect, Stop } from 'react-native-svg';
import { FILL } from '../theme.ts';

/** `linear-gradient(#5aa9f0 0%, #9fd3ff 45%, #ffe2c4 72%, #ffd0a8 78%, #9fd18a 78%, #86c46d 100%)` */
export function SkyBackdrop() {
  return (
    <View style={FILL} pointerEvents="none">
      <Svg width="100%" height="100%">
        <Defs>
          <LinearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#5aa9f0" />
            <Stop offset="0.45" stopColor="#9fd3ff" />
            <Stop offset="0.72" stopColor="#ffe2c4" />
            <Stop offset="0.78" stopColor="#ffd0a8" />
            <Stop offset="0.78" stopColor="#9fd18a" />
            <Stop offset="1" stopColor="#86c46d" />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#sky)" />
      </Svg>
    </View>
  );
}

/** `radial-gradient(ellipse at 50% 0%, #463c72, #1d1730 70%)` (elipse até o canto mais distante). */
export function DuskBackdrop() {
  return (
    <View style={FILL} pointerEvents="none">
      <Svg width="100%" height="100%">
        <Defs>
          {/* elipse "farthest-corner" do CSS: raios de √2 × (metade da largura, altura) */}
          <RadialGradient id="dusk" cx="0" cy="0" r="1" gradientTransform="translate(0.5 0) scale(0.7071 1.4142)">
            <Stop offset="0" stopColor="#463c72" />
            <Stop offset="0.7" stopColor="#1d1730" />
            <Stop offset="1" stopColor="#1d1730" />
          </RadialGradient>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#dusk)" />
      </Svg>
    </View>
  );
}

/** Gramado oval com sombra sob o herói (`.hero-platform` de 180×170). */
export function HeroPlatform() {
  return (
    <View style={FILL} pointerEvents="none">
      <Svg width={180} height={170}>
        <Defs>
          <RadialGradient
            id="shade"
            cx="0"
            cy="0"
            r="1"
            gradientUnits="userSpaceOnUse"
            gradientTransform="translate(90 156.4) scale(70 14)"
          >
            <Stop offset="0" stopColor="#1d1730" stopOpacity={0.5} />
            <Stop offset="0.7" stopColor="#1d1730" stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Ellipse cx={90} cy={153} rx={90 * 0.97} ry={26 * 0.97} fill="#86c46d" />
        <Ellipse cx={90} cy={156.4} rx={70} ry={14} fill="url(#shade)" />
      </Svg>
    </View>
  );
}

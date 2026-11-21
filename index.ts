// A task de GPS em segundo plano precisa ser definida no escopo global, antes de qualquer tela:
// quando o sistema acorda o app só para entregar posições, nenhum componente é montado.
import './src/game/bgTask';
import { registerRootComponent } from 'expo';
import App from './App.tsx';

// registerRootComponent chama AppRegistry.registerComponent('main', () => App) e prepara o ambiente
// tanto no Expo Go quanto num build nativo.
registerRootComponent(App);

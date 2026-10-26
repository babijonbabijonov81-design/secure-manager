// Polyfills first: the shared core needs them as soon as it is imported.
import './src/polyfills';
import { registerRootComponent } from 'expo';
import App from './src/App';

registerRootComponent(App);

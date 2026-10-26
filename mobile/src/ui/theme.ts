// The Veil brand on the iPhone, as on the desktop: warm black, ember for action and «me», mint
// for protection, amber for timers. No blue or violet anywhere.
import { createContext, useContext } from 'react';
import { useColorScheme } from 'react-native';

export interface Palette {
  bg: string;
  surface: string;
  surface2: string;
  line: string;
  text: string;
  text2: string;
  muted: string;
  ember: string;
  emberInk: string;
  emberSoft: string;
  mint: string;
  mintSoft: string;
  mintLine: string;
  mintText: string;
  amber: string;
  danger: string;
  bubbleIn: string;
  dark: boolean;
}

export const DARK: Palette = {
  bg: '#0C0A09',
  surface: '#151210',
  surface2: '#1D1916',
  line: '#2E2723',
  text: '#F4EFE9',
  text2: '#C9C0B6',
  muted: '#A39A90',
  ember: '#FF7A45',
  emberInk: '#1A0E08',
  emberSoft: '#2A1810',
  mint: '#3DDC97',
  mintSoft: '#11241B',
  mintLine: '#1F5A40',
  mintText: '#9FD9BC',
  amber: '#F5B700',
  danger: '#FF5A5F',
  bubbleIn: '#151210',
  dark: true,
};

export const LIGHT: Palette = {
  bg: '#FAF7F3',
  surface: '#FFFFFF',
  surface2: '#F2ECE5',
  line: '#E8E0D8',
  text: '#1A1411',
  text2: '#3D342E',
  muted: '#6B625A',
  ember: '#E2582A',
  emberInk: '#FFFFFF',
  emberSoft: '#FBE4D9',
  mint: '#14A672',
  mintSoft: '#E3F5EC',
  mintLine: '#9BD9BD',
  mintText: '#0E7A53',
  amber: '#B88400',
  danger: '#D93A3F',
  bubbleIn: '#FFFFFF',
  dark: false,
};

export const FONT = {
  regular: 'Onest_400Regular',
  medium: 'Onest_500Medium',
  semibold: 'Onest_600SemiBold',
  bold: 'Onest_700Bold',
  heavy: 'Onest_800ExtraBold',
  mono: 'JetBrainsMono_400Regular',
  monoBold: 'JetBrainsMono_600SemiBold',
};

/** Corners from the design: cards 22, bubbles 20 with 6 at the sender's side. */
export const RADIUS = { card: 22, bubble: 20, bubbleTail: 6, field: 14, pill: 999 };

export type ThemeChoice = 'system' | 'dark' | 'light';
export const ThemeContext = createContext<Palette>(DARK);
export const useTheme = () => useContext(ThemeContext);

export function usePalette(choice: ThemeChoice): Palette {
  const system = useColorScheme();
  const dark = choice === 'dark' || (choice === 'system' && system !== 'light');
  return dark ? DARK : LIGHT;
}

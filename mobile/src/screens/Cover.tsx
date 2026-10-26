// What the app switcher shows while Veil is not in front: the logo, never the chats.
import { StyleSheet, View } from 'react-native';
import { Logo } from '../ui/kit.tsx';
import { useTheme } from '../ui/theme.ts';

export function Cover() {
  const t = useTheme();
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: t.bg, alignItems: 'center', justifyContent: 'center' }]} accessibilityElementsHidden>
      <View style={{ width: 116, height: 116, borderRadius: 30, backgroundColor: t.dark ? '#1A1411' : t.surface, borderWidth: 1, borderColor: t.line, alignItems: 'center', justifyContent: 'center' }}>
        <Logo size={80} />
      </View>
    </View>
  );
}

// Tabs («Чаты · Сейф · Звонки · Ещё», a floating pill under the thumb) and the screens above them.
import { createBottomTabNavigator, type BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Bookmark, MessageSquare, Phone, Settings2 } from 'lucide-react-native';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FONT, useTheme } from '../ui/theme.ts';
import { CallsScreen } from './CallsScreen.tsx';
import { ChatInfoScreen } from './ChatInfoScreen.tsx';
import { ChatScreen } from './ChatScreen.tsx';
import { ChatsScreen } from './ChatsScreen.tsx';
import { MoreScreen } from './MoreScreen.tsx';
import { NewChatScreen } from './NewChatScreen.tsx';
import { VaultScreen } from './VaultScreen.tsx';
import type { RootStack, TabsList } from './navigation.ts';

const Stack = createNativeStackNavigator<RootStack>();
const Tabs = createBottomTabNavigator<TabsList>();

const TAB_ICONS = { Chats: MessageSquare, Vault: Bookmark, Calls: Phone, More: Settings2 } as const;
const TAB_LABELS = { Chats: 'Чаты', Vault: 'Сейф', Calls: 'Звонки', More: 'Ещё' } as const;

function PillBar({ state, navigation }: BottomTabBarProps) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View
      accessibilityRole="tablist"
      style={[styles.bar, { bottom: Math.max(insets.bottom, 12) + 4, backgroundColor: t.surface2, borderColor: t.line }]}
    >
      {state.routes.map((route, index) => {
        const name = route.name as keyof typeof TAB_ICONS;
        const Icon = TAB_ICONS[name];
        const on = state.index === index;
        return (
          <Pressable
            key={route.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            aria-selected={on}
            accessibilityLabel={TAB_LABELS[name]}
            onPress={() => {
              const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
              if (!on && !event.defaultPrevented) navigation.navigate(route.name);
            }}
            style={[styles.tab, on && { backgroundColor: t.emberSoft }]}
          >
            <Icon size={22} color={on ? t.ember : t.muted} strokeWidth={2} />
            <Text style={{ fontFamily: on ? FONT.bold : FONT.semibold, fontSize: 11, color: on ? t.ember : t.muted }}>{TAB_LABELS[name]}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function TabsScreen() {
  return (
    <Tabs.Navigator tabBar={(props) => <PillBar {...props} />} screenOptions={{ headerShown: false }}>
      <Tabs.Screen name="Chats" component={ChatsScreen} />
      <Tabs.Screen name="Vault" component={VaultScreen} />
      <Tabs.Screen name="Calls" component={CallsScreen} />
      <Tabs.Screen name="More" component={MoreScreen} />
    </Tabs.Navigator>
  );
}

export function MainNavigator() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="Tabs" component={TabsScreen} />
      <Stack.Screen name="Chat" component={ChatScreen} />
      <Stack.Screen name="NewChat" component={NewChatScreen} options={{ presentation: 'modal' }} />
      <Stack.Screen name="ChatInfo" component={ChatInfoScreen} options={{ presentation: 'modal' }} />
    </Stack.Navigator>
  );
}

/** Space the floating bar takes at the bottom of a tab's list. */
export const TAB_BAR_SPACE = 110;

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    left: 14,
    right: 14,
    height: 70,
    borderRadius: 35,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
  },
  tab: { width: 76, height: 54, borderRadius: 27, alignItems: 'center', justifyContent: 'center', gap: 2 },
});

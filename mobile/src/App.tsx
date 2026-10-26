// Veil for iPhone: the same account format, protocol and server as on the desktop.
import { JetBrainsMono_400Regular, JetBrainsMono_600SemiBold } from '@expo-google-fonts/jetbrains-mono';
import { Onest_400Regular, Onest_500Medium, Onest_600SemiBold, Onest_700Bold, Onest_800ExtraBold, useFonts } from '@expo-google-fonts/onest';
import { DarkTheme, DefaultTheme, NavigationContainer } from '@react-navigation/native';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { setThisDevice, type Messenger } from '../../src/core/messenger.ts';
import { readVaultMeta } from '../../src/core/storage.ts';
import { deviceStorage } from './platform/storage';
import { MainNavigator } from './screens/MainNavigator.tsx';
import { LockScreen } from './screens/LockScreen.tsx';
import { WelcomeFlow } from './screens/WelcomeFlow.tsx';
import { Cover } from './screens/Cover.tsx';
import { SessionContext, type Session } from './state/session.tsx';
import { loadPrefs, savePrefs, type PhonePrefs } from './state/prefs.ts';
import { PhotoSource, ToastProvider } from './ui/kit.tsx';
import { ThemeContext, usePalette } from './ui/theme.ts';
import { PrefsContext } from './state/prefsContext.ts';

type Phase = 'loading' | 'welcome' | 'locked' | 'ready';

export default function App() {
  const [fontsLoaded] = useFonts({
    Onest_400Regular,
    Onest_500Medium,
    Onest_600SemiBold,
    Onest_700Bold,
    Onest_800ExtraBold,
    JetBrainsMono_400Regular,
    JetBrainsMono_600SemiBold,
  });
  const storage = useMemo(deviceStorage, []);
  const [phase, setPhase] = useState<Phase>('loading');
  const [messenger, setMessenger] = useState<Messenger | null>(null);
  const [prefs, setPrefs] = useState<PhonePrefs | null>(null);
  const [covered, setCovered] = useState(false);
  const palette = usePalette(prefs?.theme ?? 'system');
  const backgroundSince = useRef<number | null>(null);

  useEffect(() => {
    void (async () => {
      const loaded = await loadPrefs();
      setPrefs(loaded);
      setThisDevice({ id: loaded.deviceId, name: Platform.OS === 'ios' ? 'iPhone' : 'Телефон' });
      setPhase((await readVaultMeta(storage)) ? 'locked' : 'welcome');
    })();
  }, [storage]);

  const lock = useCallback(() => {
    setMessenger((current) => {
      void current?.lock();
      return null;
    });
    setPhase('locked');
  }, []);

  // In the app switcher the logo shows instead of the chats; after the chosen time away, Veil locks.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      setCovered(state !== 'active');
      if (state === 'background') {
        backgroundSince.current = Date.now();
        if (prefs?.lockAfter === 0) lock();
      } else if (state === 'active' && backgroundSince.current) {
        const away = Date.now() - backgroundSince.current;
        backgroundSince.current = null;
        if (prefs && away >= prefs.lockAfter * 60_000) lock();
      }
    });
    return () => subscription.remove();
  }, [prefs, lock]);

  const session: Session | null = useMemo(() => (messenger ? { messenger, storage, lock } : null), [messenger, storage, lock]);
  const photos = useMemo(() => (messenger ? (id: string) => messenger.getAvatar(id) : null), [messenger]);
  const prefsApi = useMemo(
    () =>
      prefs && {
        prefs,
        update(patch: Partial<PhonePrefs>) {
          const next = { ...prefs, ...patch };
          setPrefs(next);
          void savePrefs(next);
        },
      },
    [prefs],
  );

  const opened = (m: Messenger) => {
    setMessenger(m);
    setPhase('ready');
  };

  const navTheme = palette.dark ? DarkTheme : DefaultTheme;
  if (!fontsLoaded || phase === 'loading' || !prefsApi) return <View style={{ flex: 1, backgroundColor: palette.bg }} />;

  return (
    <SafeAreaProvider>
      <ThemeContext.Provider value={palette}>
        <PrefsContext.Provider value={prefsApi}>
          <ToastProvider>
            <StatusBar style={palette.dark ? 'light' : 'dark'} />
            {phase === 'welcome' && <WelcomeFlow storage={storage} onOpened={opened} />}
            {phase === 'locked' && <LockScreen storage={storage} onOpened={opened} />}
            {phase === 'ready' && session && (
              <SessionContext.Provider value={session}>
                <PhotoSource.Provider value={photos}>
                  <NavigationContainer
                    theme={{ ...navTheme, colors: { ...navTheme.colors, background: palette.bg, card: palette.bg, text: palette.text, border: palette.line, primary: palette.ember } }}
                  >
                    <MainNavigator />
                  </NavigationContainer>
                </PhotoSource.Provider>
              </SessionContext.Provider>
            )}
            {covered && Platform.OS !== 'web' && <Cover />}
          </ToastProvider>
        </PrefsContext.Provider>
      </ThemeContext.Provider>
    </SafeAreaProvider>
  );
}


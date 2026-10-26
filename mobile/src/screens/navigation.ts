import type { NavigatorScreenParams } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

export type TabsList = {
  Chats: undefined;
  Vault: undefined;
  Calls: undefined;
  More: undefined;
};

export type RootStack = {
  Tabs: NavigatorScreenParams<TabsList> | undefined;
  Chat: { id: string };
  NewChat: undefined;
  ChatInfo: { id: string };
};

export type StackProps<T extends keyof RootStack> = NativeStackScreenProps<RootStack, T>;

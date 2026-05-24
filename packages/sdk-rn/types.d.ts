declare module "expo-asset" {
  export const Asset: {
    fromModule(source: number): {
      downloadAsync(): Promise<{ localUri?: string | null }>;
    };
  };
}

declare module "react-native-fs" {
  export const CachesDirectoryPath: string;
  export function exists(path: string): Promise<boolean>;
  export function downloadFile(options: {
    fromUrl: string;
    toFile: string;
  }): { promise: Promise<unknown> };
}

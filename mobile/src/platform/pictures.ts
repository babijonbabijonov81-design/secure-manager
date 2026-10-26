// Pictures from the photo library: drawn anew as JPEG (which leaves EXIF and the geotag behind),
// squared for a profile photo, scaled for a wallpaper or a message.
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { unb64 } from '../../../server/src/shared/wire.ts';

export interface Picked {
  data: Uint8Array;
  width: number;
  height: number;
}

/** Standard base64 (from the manipulator) to bytes. */
const fromBase64 = (value: string) => unb64(value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));

async function pick(): Promise<ImagePicker.ImagePickerAsset | null> {
  const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1, exif: false });
  return result.canceled ? null : (result.assets[0] ?? null);
}

async function render(uri: string, width: number, height: number, square: number | null, maxSide: number, quality: number): Promise<Picked> {
  const context = ImageManipulator.manipulate(uri);
  let w = width;
  let h = height;
  if (square) {
    const side = Math.min(width, height);
    context.crop({ originX: (width - side) / 2, originY: (height - side) / 2, width: side, height: side });
    context.resize({ width: square, height: square });
    w = h = square;
  } else {
    const scale = Math.min(1, maxSide / Math.max(width, height));
    if (scale < 1) {
      w = Math.round(width * scale);
      h = Math.round(height * scale);
      context.resize({ width: w, height: h });
    }
  }
  const image = await context.renderAsync();
  const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: quality, base64: true });
  return { data: fromBase64(saved.base64 ?? ''), width: saved.width || w, height: saved.height || h };
}

/** A profile photo: the middle square at 512×512, under 240 KB. */
export async function pickAvatar(): Promise<Uint8Array | null> {
  const asset = await pick();
  if (!asset) return null;
  for (const quality of [0.86, 0.72, 0.58]) {
    const picked = await render(asset.uri, asset.width, asset.height, 512, 512, quality);
    if (picked.data.length <= 240 * 1024) return picked.data;
  }
  throw new Error('Не удалось уменьшить фото');
}

export async function pickWallpaper(): Promise<Uint8Array | null> {
  const asset = await pick();
  return asset ? (await render(asset.uri, asset.width, asset.height, null, 2560, 0.85)).data : null;
}

/** A photo for a message: at most 2560 px, as the desktop sends them. */
export async function pickPhoto(): Promise<Picked | null> {
  const asset = await pick();
  return asset ? render(asset.uri, asset.width, asset.height, null, 2560, 0.86) : null;
}

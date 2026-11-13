/**
 * Types for the two `qrcode` internals the Host imports.
 *
 * The package ships no declarations for its deep paths and its published types cover
 * the entry point only. Declaring the two functions here keeps the deep import typed
 * without adding a types package for a surface this plugin uses in one file.
 */

declare module 'qrcode/lib/core/qrcode.js' {
  /** An encoded matrix, opaque to callers. */
  interface QrData {
    readonly modules: {
      readonly size: number
      readonly data: Uint8Array
    }
  }

  /**
   * Encode text into a matrix.
   *
   * @param text - the content to encode.
   * @param options - encoding options.
   * @returns the matrix.
   */
  export function create(
    text: string,
    options?: { errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H' },
  ): QrData
}

declare module 'qrcode/lib/renderer/svg-tag.js' {
  /** An encoded matrix from the core module. */
  interface QrData {
    readonly modules: {
      readonly size: number
      readonly data: Uint8Array
    }
  }

  /**
   * Draw a matrix as an SVG document.
   *
   * @param data - the matrix to draw.
   * @param options - size and margin options.
   * @returns the SVG markup.
   */
  export function render(
    data: QrData,
    options?: { margin?: number; width?: number; type?: 'svg' },
  ): string
}

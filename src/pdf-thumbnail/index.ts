import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, parse } from 'node:path'

import { pdfToPng } from 'pdf-to-png-converter'
import sharp from 'sharp'

const DEFAULT_MAX_BYTES = 200 * 1024
const DEFAULT_DIMENSION_CANDIDATES = [320, 280, 240, 200, 160]
const DEFAULT_QUALITY_CANDIDATES = [82, 74, 66, 58, 50, 42]
const DEFAULT_VIEWPORT_SCALE = 2

export interface GeneratePdfThumbnailOptions {
  pdfPath: string
  outputPath?: string
  maxBytes?: number
  dimensionCandidates?: number[]
  qualityCandidates?: number[]
  viewportScale?: number
}

export interface PdfThumbnailResult {
  bytes: Uint8Array
  width: number
  height: number
  filename: string
  outputPath?: string
}

export async function generatePdfThumbnail(options: GeneratePdfThumbnailOptions): Promise<PdfThumbnailResult> {
  const pngPage = await renderFirstPageToPng(options.pdfPath, options.viewportScale ?? DEFAULT_VIEWPORT_SCALE)
  const rendered = await encodeJpegThumbnail(
    pngPage,
    options.maxBytes ?? DEFAULT_MAX_BYTES,
    options.dimensionCandidates ?? DEFAULT_DIMENSION_CANDIDATES,
    options.qualityCandidates ?? DEFAULT_QUALITY_CANDIDATES,
  )
  const outputPath = options.outputPath

  if (outputPath) {
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, rendered.bytes)
  }

  return {
    ...rendered,
    filename: `${parse(options.pdfPath).name}.telegram-thumb.jpg`,
    outputPath,
  }
}

async function renderFirstPageToPng(pdfPath: string, viewportScale: number): Promise<Buffer> {
  const pdfBytes = await readFile(pdfPath)
  const pages = await pdfToPng(pdfBytes, {
    pagesToProcess: [1],
    viewportScale,
    returnPageContent: true,
    outputFolder: undefined,
    verbosityLevel: 0,
  })
  const firstPage = pages[0]

  if (!firstPage?.content) {
    throw new Error(`Failed to render the first PDF page for ${basename(pdfPath)}.`)
  }

  return firstPage.content
}

async function encodeJpegThumbnail(
  pngBytes: Buffer,
  maxBytes: number,
  dimensionCandidates: number[],
  qualityCandidates: number[],
): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  let bestEffort: { bytes: Uint8Array; width: number; height: number } | undefined

  for (const dimension of dimensionCandidates) {
    for (const quality of qualityCandidates) {
      const { data, info } = await sharp(pngBytes)
        .resize({
          width: dimension,
          height: dimension,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .flatten({ background: '#ffffff' })
        .jpeg({
          quality,
          mozjpeg: true,
          progressive: true,
        })
        .toBuffer({ resolveWithObject: true })

      const candidate = {
        bytes: data,
        width: info.width,
        height: info.height,
      }

      if (bestEffort === undefined) {
        bestEffort = candidate
      }

      if (data.byteLength <= maxBytes) {
        return candidate
      }
    }
  }

  if (bestEffort) {
    return bestEffort
  }

  throw new Error('Failed to encode a JPEG thumbnail.')
}

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { ImagePlus } from '@lucide/vue'
import { useJobs } from '../stores/jobs'
import { useUi } from '../stores/ui'

const jobs = useJobs()
const ui = useUi()
const over = ref(false)
const filePicker = ref<HTMLInputElement | null>(null)
const dirPicker = ref<HTMLInputElement | null>(null)

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|tiff?|heic|heif|avif)$/i
const isImage = (f: File) => f.type.startsWith('image/') || IMAGE_EXT.test(f.name)

async function send(files: File[]) {
  const imgs = files.filter(isImage)
  const skipped = files.length - imgs.length
  if (!imgs.length) {
    ui.toast(skipped ? '没有找到图片文件' : '没有选择文件', 'warn')
    return
  }
  const r = await ui.act(() => jobs.upload(imgs))
  if (r) report(r.added, r.errors, skipped)
}

function report(added: number, errors: { name: string; error: string }[], skipped = 0) {
  ui.workTab = 'todo'
  let msg = `已加入 ${added} 张，排在队尾`
  if (errors.length) msg += `；${errors.length} 张没加进去：${errors.map((e) => `${e.name}（${e.error}）`).join('、')}`
  if (skipped) msg += `；跳过 ${skipped} 个非图片文件`
  ui.toast(msg, errors.length ? 'warn' : 'info')
}

/** 拖进来的可能是文件夹，逐层展开 */
async function filesFromDrop(dt: DataTransfer): Promise<File[]> {
  const entries = Array.from(dt.items ?? [])
    .map((it) => (it.kind === 'file' ? it.webkitGetAsEntry?.() : null))
    .filter((e): e is FileSystemEntry => !!e)
  if (!entries.length) return Array.from(dt.files)
  const out: File[] = []
  const walk = async (e: FileSystemEntry): Promise<void> => {
    if (e.isFile) {
      out.push(await new Promise<File>((res, rej) => (e as FileSystemFileEntry).file(res, rej)))
    } else if (e.isDirectory) {
      const reader = (e as FileSystemDirectoryEntry).createReader()
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej))
        if (!batch.length) break
        for (const c of batch) await walk(c)
      }
    }
  }
  for (const e of entries) await walk(e)
  return out
}

async function onDrop(e: DragEvent) {
  over.value = false
  if (!e.dataTransfer) return
  await send(await filesFromDrop(e.dataTransfer))
}

function onPicked(e: Event) {
  const input = e.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  void send(files)
}

/** 剪贴板里的图片：截图、网页上「复制图片」得到的是图片本身 */
function clipboardImages(cd: DataTransfer): File[] {
  const files = Array.from(cd.files)
  if (!files.length) for (const it of Array.from(cd.items)) if (it.kind === 'file') files.push(it.getAsFile()!)
  return files.filter((f) => f && isImage(f))
}

/**
 * 焦点在输入框里时不拦截粘贴，否则提示词框里粘贴文字会被吃掉。
 * 在访达里复制的文件，浏览器只给得到文件图标，所以先让本机服务读剪贴板里的文件路径，读不到再用浏览器给的图片。
 */
function onPaste(e: ClipboardEvent) {
  const el = document.activeElement as HTMLElement | null
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
  const cd = e.clipboardData
  if (!cd) return
  e.preventDefault()
  const stamp = Date.now()
  const browserFiles = clipboardImages(cd).map((f, i) =>
    f.name && f.name !== 'image.png' ? f : new File([f], `粘贴-${stamp}-${i + 1}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type }),
  )
  void pasteFlow(browserFiles)
}

async function pasteFlow(browserFiles: File[]) {
  if (jobs.uploading) return
  const r = await jobs.fromClipboard().catch(() => null)
  if (r?.jobs.length || r?.errors.length) return report(r.jobs.length, r.errors)
  if (r?.copied) return ui.toast('复制的文件里没有图片', 'warn')
  if (browserFiles.length) return send(browserFiles)
  ui.toast('剪贴板里没有图片。在访达里选中图片按 ⌘C（Windows 按 Ctrl+C），或截图、复制网页上的图片后，回到这里按 ⌘V / Ctrl+V', 'warn')
}

onMounted(() => document.addEventListener('paste', onPaste))
onBeforeUnmount(() => document.removeEventListener('paste', onPaste))
</script>

<template>
  <div class="drop" :class="{ over }" @dragover.prevent="over = true" @dragleave.self="over = false" @drop.prevent="onDrop">
    <div class="ic"><ImagePlus aria-hidden="true" /></div>
    <div class="t">
      <b>拖入或粘贴竞品图</b>
      <span v-if="jobs.uploading" class="muted small">上传中 {{ Math.round(jobs.uploading.ratio * 100) }}%（共 {{ jobs.uploading.total }} 张）</span>
      <span v-else class="muted small">在访达里选中图片或文件夹按 ⌘C，回到这里按 ⌘V（Windows 用 Ctrl+C / Ctrl+V）；任意品类混在一起都行，运行中也能继续加</span>
    </div>
    <button type="button" class="btn" :disabled="!!jobs.uploading" @click="filePicker?.click()">选择图片</button>
    <button type="button" class="btn" :disabled="!!jobs.uploading" @click="dirPicker?.click()">选择文件夹</button>
    <input ref="filePicker" type="file" accept="image/*" multiple hidden @change="onPicked" />
    <input ref="dirPicker" type="file" webkitdirectory multiple hidden @change="onPicked" />
  </div>
</template>

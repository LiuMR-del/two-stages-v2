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
  if (!r) return
  ui.workTab = 'queue'
  let msg = `已加入 ${r.added} 张，排在队尾`
  if (r.errors.length) msg += `；${r.errors.length} 张没加进去：${r.errors.map((e) => `${e.name}（${e.error}）`).join('、')}`
  if (skipped) msg += `；跳过 ${skipped} 个非图片文件`
  ui.toast(msg, r.errors.length ? 'warn' : 'info')
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

/** 焦点在输入框里时不拦截粘贴，否则提示词框里粘贴文字会被吃掉 */
function onPaste(e: ClipboardEvent) {
  const el = document.activeElement as HTMLElement | null
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
  const files = Array.from(e.clipboardData?.files ?? []).filter(isImage)
  if (!files.length) return
  e.preventDefault()
  const named = files.map((f, i) => (f.name && f.name !== 'image.png' ? f : new File([f], `粘贴-${Date.now()}-${i + 1}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type })))
  void send(named)
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
      <span v-else class="muted small">任意品类混在一起都行，运行中也能继续加；也可以拖入整个文件夹</span>
    </div>
    <button type="button" class="btn" :disabled="!!jobs.uploading" @click="filePicker?.click()">选择图片</button>
    <button type="button" class="btn" :disabled="!!jobs.uploading" @click="dirPicker?.click()">选择文件夹</button>
    <input ref="filePicker" type="file" accept="image/*" multiple hidden @change="onPicked" />
    <input ref="dirPicker" type="file" webkitdirectory multiple hidden @change="onPicked" />
  </div>
</template>

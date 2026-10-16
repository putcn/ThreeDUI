<script setup lang="ts">
// The bin info panel's content (spatial spec §4 step 3, §11.4): what a hovered bin holds, on the glass panel that
// floats in front of the twin (Spatial.vue's world <Surface>), with the info panels' veil and entrance (panel.ts).
import { computed } from 'vue'
import { Box, Stack, Text } from '@glassui/vue'
import { binLevel, grouped, type Bin } from './data'
import { useInfoPanel } from './panel'

const props = defineProps<{ bin: Bin }>()
const level = computed(() => binLevel(props.bin.occupancy))
const percent = computed(() => Math.round(props.bin.occupancy * 100))
const { veil } = useInfoPanel()
</script>

<template>
  <Stack :gap="5" :style="{ margin: 8, flexGrow: 1, radius: 20, bg: veil, paddingX: 16, paddingY: 12 }">
    <Stack direction="horizontal" justify="between" align="center">
      <Text value="库位" :size="13" color="secondaryLabel" />
      <Stack direction="horizontal" align="center" :gap="5" :style="{ paddingX: 9, height: 20, radius: 'capsule', bg: `${level.color}38` }">
        <Box :style="{ width: 7, height: 7, radius: 3.5, bg: level.color }" />
        <Text :value="level.label" :size="12" :weight="600" />
      </Stack>
    </Stack>
    <Text :value="bin.id" :size="26" :weight="700" :style="{ font: 'Menlo' }" :wrap="false" />
    <Text :value="`${bin.sku} · ${bin.name}`" :size="14" color="secondaryLabel" :max-lines="1" />
    <Stack direction="horizontal" justify="between" align="center">
      <Text :value="[{ text: grouped(bin.qty), weight: 700 }, { text: ` / ${grouped(bin.cap)} 件`, color: 'secondaryLabel' }]" :size="15" :wrap="false" />
      <Text :value="`占用率 ${percent}%`" :size="13" color="secondaryLabel" :wrap="false" />
    </Stack>
    <Box :style="{ height: 8, radius: 4, bg: '#1c1c2214' }">
      <Box :style="{ width: `${percent}%`, height: 8, radius: 4, bg: level.color }" />
    </Box>
  </Stack>
</template>

<script setup lang="ts">
import { Button, Stack, Text } from '@glassui/vue'
import { useSpatialLocale } from './locale'
const { t } = useSpatialLocale()
const props = defineProps<{ title: string; id?: string }>()
const emit = defineEmits<{ navigate: [name: null] }>()
</script>
<template>
  <Stack direction="horizontal" align="center" :gap="4">
    <Button :id="props.id ?? 'crumb-overview'" :label="t('总览')" size="small" variant="plain" @press="emit('navigate', null)" />
    <Text :value="`/ ${title}`" :size="14" color="tertiaryLabel" />
  </Stack>
</template>

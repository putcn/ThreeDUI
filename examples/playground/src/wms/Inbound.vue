<script setup lang="ts">
import { computed, ref } from 'vue'
import { Button, Checkbox, Dialog, Input, Stack, Switch, Text } from '@glassui/vue'
import { inboundNumber, validateInbound, type InboundForm } from './forms'
import { useSpatialLocale } from './locale'
const { t } = useSpatialLocale()
const props = defineProps<{ embedded?: boolean }>()
const emit = defineEmits<{ close: [] }>()
const blank = (): InboundForm => ({ supplier: '', poNumber: '', sku0: '', qty0: '', sku1: '', qty1: '', sku2: '', qty2: '', sampled: false, coldChain: false, note: '' })
const form = ref(blank()), errors = ref<Partial<Record<keyof InboundForm, string>>>({}), confirm = ref(false), loading = ref(false), success = ref('')
const rows = [0, 1, 2] as const
const summary = computed(() => `${form.value.supplier} · ${form.value.poNumber} · ${rows.filter(i => form.value[`sku${i}`]).map(i => `${form.value[`sku${i}`]} × ${form.value[`qty${i}`]}`).join('、')}`)
let seq = 0
function submit(): void { errors.value = validateInbound(form.value); if (!Object.keys(errors.value).length) confirm.value = true }
function confirmInbound(): void {
  confirm.value = false; loading.value = true
  setTimeout(() => { loading.value = false; success.value = `${t('入库单')} ${inboundNumber(new Date(2026, 9, 16), ++seq)} ${t('已提交')}`; form.value = blank() }, 800)
}
</script>
<template>
  <Stack :gap="18">
    <Text v-if="success" id="inbound-success" :value="success" color="success" :weight="600" />
    <Stack direction="horizontal" :gap="16"><Stack :gap="4"><Input v-model="form.supplier" :placeholder="t('供应商')"/><Text v-if="errors.supplier" :value="t(errors.supplier)" color="danger"/></Stack><Stack :gap="4"><Input v-model="form.poNumber" :placeholder="t('采购单号')"/><Text v-if="errors.poNumber" :value="t(errors.poNumber)" color="danger"/></Stack></Stack>
    <Stack v-for="i in rows" :key="i" direction="horizontal" :gap="16" align="center"><Text :value="`SKU ${i + 1}`" :style="{ width: 76 }"/><Input v-model="form[`sku${i}`]" :placeholder="t('SKU 编码')"/><Input :id="`inbound-qty-${i}`" v-model="form[`qty${i}`]" type="number" :placeholder="t('数量')"/><Text v-if="errors[`sku${i}`]" :value="t(errors[`sku${i}`]!)" color="danger"/><Text v-if="errors[`qty${i}`]" :value="t(errors[`qty${i}`]!)" color="danger"/></Stack>
    <Stack direction="horizontal" align="center" :gap="24"><Checkbox v-model:checked="form.sampled">{{ t('已抽检') }}</Checkbox><Switch v-model:checked="form.coldChain" :label="t('需要冷链')" /></Stack>
    <Input v-model="form.note" :placeholder="t('备注')" />
    <Stack direction="horizontal" justify="end" :gap="12"><Button :label="t(props.embedded ? '取消' : '暂存')" @press="emit('close')"/><Button id="inbound-submit" variant="glassProminent" :label="t('提交入库')" :loading="loading" @press="submit"/></Stack>
    <Dialog v-model:open="confirm" :title="t('确认入库信息')"><Text :value="summary"/><template #footer><Button :label="t('返回修改')" @press="confirm = false"/><Button id="inbound-confirm" variant="glassProminent" :label="t('确认提交')" @press="confirmInbound"/></template></Dialog>
  </Stack>
</template>

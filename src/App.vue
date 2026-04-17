<template>

  <el-main class="p-0 relative h-screen w-screen overflow-hidden">
    <div class="absolute left-6 top-1/2 -translate-y-1/2 z-50">
      <!-- <DynamicTimeline :data="timelineData" /> -->
    </div>
    <CesiumViewer />
  </el-main>
</template>

<script setup lang="ts">
import CesiumViewer from './components/CesiumViewer.vue'
import DynamicTimeline from './components/DynamicTimeline.vue';

const timelineData = [
  {
    id: 1,
    type: 'start',
    title: '开始',
    description: '初始化配置与资源准备'
  },
  {
    id: 2,
    type: 'process',
    title: '辐射定标',
    description: '执行辐射定标算法',
    status: 'running',
    progress: 45
  },
  {
    id: 3,
    type: 'process',
    title: '智能分析',
    description: '并行提取',
    branches: [
      { label: '算法 A', title: '植被指数提取', color: 'text-emerald-400' },
      { label: '算法 B', title: '水体边缘检测', color: 'text-blue-400' },
      { label: '算法 C', title: '建筑轮廓识别', color: 'text-purple-400' }
    ]
  },
  {
    id: 4,
    type: 'process',
    title: '质量检验',
    description: '自动对提取结果进行精度验证',
    status: 'pending'
  },
  {
    id: 5,
    type: 'end',
    title: '成果产出',
    description: '生成最终分析报表与图层'
  }
];
</script>

<style>
/* Remove default element plus padding if necessary */
.el-main {
  --el-main-padding: 0 !important;
}
.cesium-viewer-bottom {
  display: none !important;
}
.cesium-credit-logoContainer{
  display: none !important;
}
</style>

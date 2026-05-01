export const extension_name = 'bf-agentic-curator';

jQuery(async () => {
    try {
        const { initSettings } = await import('./src/settings.js');
        await initSettings();

        const { initStatusUI } = await import('./src/ui-status.js');
        initStatusUI();

        const { initInterceptor } = await import('./src/interceptor.js');
        initInterceptor();

        const { initPipeline } = await import('./src/pipeline.js');
        initPipeline();

        console.log('[BFCurator] Extension loaded successfully');
    } catch (error) {
        console.error('[BFCurator] Failed to load extension:', error);
    }
});

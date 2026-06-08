<?php
/**
 * GASF Code Snippet #22 — "Calendar Print Button (page 8647)"
 *
 * Lives in the Code Snippets plugin (DB table _4UX_snippets, id=22), scope
 * front-end, active. This file is the version-controlled source of truth.
 *
 * NOTE: The Code Snippets `code` column stores everything BELOW the <?php line
 * (the plugin supplies the opening tag). The deploy step strips this first line
 * before writing to the DB; the <?php is here only so the file lints and reads
 * as PHP.
 *
 * Behavior: appends a "Print Calendar" button below the calendar on page 8647
 * that opens the pre-rendered one-page landscape PDF in a new tab. The PDF is
 * refreshed ~4x/day by the headless-Chrome render job on the Jabra box
 * (/opt/gasf-print-calendar -> wp-content/uploads/calendar.pdf). Linking to the
 * PDF guarantees a single landscape page when printed, which the CSS-only
 * @media print approach could not. Styling is unchanged (.gasf-print-calendar-btn).
 */
add_filter( 'the_content', function( $content ) {
    if ( ! is_page( 8647 ) || ! in_the_loop() || ! is_main_query() ) {
        return $content;
    }

    $pdf = '/wp-content/uploads/calendar.pdf';

    $button = '<div class="gasf-print-calendar-wrap">'
            . '<a class="gasf-print-calendar-btn" href="' . esc_url( $pdf ) . '" target="_blank" rel="noopener">'
            . '<span aria-hidden="true">&#128424;</span> Print Calendar'
            . '</a></div>';

    return $content . $button;
}, 20 );

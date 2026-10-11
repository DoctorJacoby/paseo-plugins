# Working on this plugin

Run `paseo plugin reload catppuccin-theme` after every change; it is the only compile check of the client bundle.
Do this yourself rather than leaving it to the user.

The plugin is four `addTheme` calls in `index.client.ts` and has no server entry.

## Theme tokens

- A contribution takes exactly the eight colours in `PluginThemeColors`; the host parses it strictly, so an extra key is rejected, not ignored.
- `statusSuccess` and `statusWarning` exist on `PluginTheme`, which a plugin receives, not on the contribution. Fix a clash with the app's status colours by picking a different palette colour for one of the eight.
- Paseo derives `surface3` from `border`, and `surface4` and `foregroundExtraMuted` from `ring`, so those two choose more than their names say.
- All four flavours use the same palette-to-token mapping; a fix to one belongs in all four.

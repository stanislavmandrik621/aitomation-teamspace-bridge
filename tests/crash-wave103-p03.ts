import {open} from 'node:fs/promises'
import {assembleBackupWave103P03} from '../src/wave103-p03-backup-assembly.js'
const f=JSON.parse(process.argv[2])
const output=await open(f.outputPath,'r+')
await assembleBackupWave103P03({output,outputPath:f.outputPath,database:f.database,binding:'owner',check:()=>{},admit:async()=>{},sources:async function*(){yield f.entries[0];process.exit(17)}})

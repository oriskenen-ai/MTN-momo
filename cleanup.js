#!/usr/bin/env node

/**
 * MTN MoMo Uganda Loans - Database Cleanup Script
 * 
 * Usage:
 *   node cleanup.js apps       - Delete all applications
 *   node cleanup.js admins     - Delete all admins
 *   node cleanup.js subs       - Delete all subscriptions
 *   node cleanup.js all        - Delete everything
 * 
 * WARNING: These actions are IRREVERSIBLE! Make sure you have a backup.
 */

const db = require('./database');
require('dotenv').config();

async function cleanup() {
    try {
        console.log('\n🔄 Connecting to database...');
        await db.connectDatabase();
        console.log('✅ Connected!\n');
        
        const choice = (process.argv[2] || '').toLowerCase();
        
        if (!['apps', 'admins', 'subs', 'all'].includes(choice)) {
            console.log(`
╔════════════════════════════════════════════════════════╗
║      MTN MoMo Uganda Loans - Database Cleanup Utility         ║
╚════════════════════════════════════════════════════════╝

📋 USAGE:
  node cleanup.js apps       Delete all applications
  node cleanup.js admins     Delete all admins
  node cleanup.js subs       Delete all subscriptions
  node cleanup.js all        Delete everything

⚠️  WARNING: These actions are IRREVERSIBLE!
            Make sure you have a backup first.

📊 EXAMPLES:
  node cleanup.js apps       (Safe - only clears test data)
  node cleanup.js all        (Careful - clears everything)

💡 TIP: Take a backup of your database before cleanup!
            `);
            process.exit(1);
        }
        
        if (choice === 'apps' || choice === 'all') {
            console.log('🗑️  Deleting all applications...');
            try {
                const result = await db.deleteAllApplications();
                console.log(`   ✅ Deleted ${result.deletedCount} application(s)\n`);
            } catch (error) {
                console.error(`   ❌ Error deleting applications: ${error.message}\n`);
            }
        }
        
        if (choice === 'admins' || choice === 'all') {
            console.log('🗑️  Deleting all admins...');
            try {
                const result = await db.deleteAllAdmins();
                console.log(`   ✅ Deleted ${result.deletedCount} admin(s)\n`);
            } catch (error) {
                console.error(`   ❌ Error deleting admins: ${error.message}\n`);
            }
        }
        
        if (choice === 'subs' || choice === 'all') {
            console.log('🗑️  Deleting all subscriptions...');
            try {
                const result = await db.deleteAllSubscriptions();
                console.log(`   ✅ Deleted ${result.deletedCount} subscription(s)\n`);
            } catch (error) {
                console.error(`   ❌ Error deleting subscriptions: ${error.message}\n`);
            }
        }
        
        console.log('✅ Cleanup complete!');
        console.log('📊 Database ready for fresh data.\n');
        
        await db.closeDatabase();
        process.exit(0);
        
    } catch (error) {
        console.error('\n❌ Cleanup error:', error.message);
        console.error('\n⚠️  Make sure:');
        console.error('   1. Your .env file has MONGODB_URI set');
        console.error('   2. You can connect to the database');
        console.error('   3. You have permission to delete data\n');
        process.exit(1);
    }
}

cleanup();

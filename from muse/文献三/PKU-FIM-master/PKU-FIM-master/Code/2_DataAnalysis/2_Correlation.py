# python 3.9
# 计算spearman/pearson correlation/RMSE/MAE

import numpy as np
from scipy import stats
import pandas as pd
import matplotlib.pyplot as plt
import seaborn as sns
import matplotlib.colors as mcolors
from matplotlib.colors import LinearSegmentedColormap


if __name__ == '__main__':
    path = 'D:/LW/ABM'
    # path = '/remote-home/tls/LW/ABM'

    outputPath = path + '/OutputData'
    granularity = '1km'
    shelter_weight = 0.1

    flow_type = 'inflow'
    sigma = 1

    for city in ['zhengzhou', 'shenzhen']:
        print(city, 'sigma=' + str(sigma), flow_type, '-'*30)
        basePath = outputPath + '/Result/' + city + '/' + 'shelter weight-' + str(shelter_weight) + '/' + granularity
        storagePath = basePath + '/sigma=' + str(sigma)
        pic_storagePath = basePath + '/pic/sigma=' + str(sigma)

        # 读取数据
        flow_dur_aveHour_map = np.load(storagePath + '/' + flow_type + 'GroundTruth_Map.npy')
        groundTruth = np.load(storagePath + '/' + flow_type + 'GroundTruth_LabelMap.npy')

        flow_pred_ave = np.load(storagePath + '/' + flow_type + 'Pred_Map.npy')
        prediction_label = np.load(storagePath + '/' + flow_type + 'Pred_LabelMap.npy')

        # 先读数据，处理数据
        pre = flow_pred_ave[-1]
        tru = flow_dur_aveHour_map

        # 边界外，bbox内位置
        mask = np.isnan(groundTruth)

        # 计算correlation
        # norm
        tru1 = (tru - np.nanmin(tru)) / (np.nanmax(tru) - np.nanmin(tru))
        pre1 = (pre - np.nanmin(pre)) / (np.nanmax(pre) - np.nanmin(pre))

        preNormList = pre1[~mask].tolist()
        truNormList = tru1[~mask].tolist()

        c, p = stats.pearsonr(truNormList, preNormList)
        s, p1 = stats.spearmanr(truNormList, preNormList)

        print('Pearson correlation：%s' % c)
        print('p-value：%s' % p)
        print('Spearman correlation：%s' % s)
        print('p-value：%s' % p1)

        # 计算RMSE
        rmse = np.sqrt(np.mean((np.array(truNormList) - np.array(preNormList)) ** 2))
        # 计算MAE
        mae = np.mean(np.abs(np.array(truNormList) - np.array(preNormList)))

        print("RMSE:", rmse)
        print("MAE:", mae)

        # TOST
        # Magnitude of region of similarity
        bound = 0.1
        # Unpaired two-sample t-test
        _, p_greater = stats.ttest_ind(np.array(truNormList) + bound, preNormList, alternative='greater')
        _, p_less = stats.ttest_ind(np.array(truNormList) - bound, preNormList, alternative='less')
        # Choose the maximum p-value
        pval = max(p_less, p_greater)
        print('p_less=', p_less, 'p_greater=', p_greater)
        # print(f'TOST: p = {pval:5.3f}')



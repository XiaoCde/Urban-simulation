# -*-coding:utf-8 -*-
#python 3.9
# 根据inflow绘制zhengzhou和shenzhen的地图

"""
# @File       : 3_InflowHeatmap(zz&sz).py
# @software   : PyCharm  
# @Time       ：2024/7/20 15:35
# @Author     ：Wei Lyu
"""

import numpy as np
import matplotlib.cm as cm
import matplotlib.pyplot as plt
import pandas as pd
from scipy.stats import boxcox
import geopandas as gpd
import matplotlib.colors as mcolors
from matplotlib.colors import LinearSegmentedColormap
from sklearn.preprocessing import MinMaxScaler

plt.rcParams['pdf.fonttype'] = 42 # pdf嵌入字体，方便放到AI编辑

# 定义 Box-Cox 变换函数
def boxcox_transform(x, lmbda):
    # 将 NaN 替换为 1，以避免 boxcox 函数报错
    x_nonan = np.where(np.isnan(x), 1, x + 1e-6)
    transformed = boxcox(x_nonan, lmbda)
    # 将原始的 NaN 值还原
    return np.where(np.isnan(x), np.nan, transformed)

# 定义反向 Box-Cox 变换函数
def inv_boxcox_transform(x, lmbda):
    if lmbda == 0:
        return np.where(np.isnan(x), np.nan, np.exp(x))
    else:
        return np.where(np.isnan(x), np.nan, np.power((x * lmbda + 1), 1 / lmbda))


if __name__ == '__main__':
    path = 'D:/LW/ABM'
    outputPath = path + '/OutputData'

    lmbda = 0.5
    granularity = '3km'
    shelter_weight = 0.1
    sigma = 1

    cities = ['zhengzhou', 'shenzhen']
    # shp_path = ['studyarea_tid/studyarea_tid.shp', '大湾区&深圳市shp/大湾区&深圳市网格shp(051_地级市区县)/大湾区1km网格.shp']
    shp_path = ['zz_tid_' + granularity + '/zz_tid_' + granularity + '.shp', 'sz_tid_' + granularity + '/sz_tid_' + granularity + '.shp']

    for type in ['inflow']:
        fields = ['pred_', 'tru_']
        fields = [item + type for item in fields]
        names = ['Pred', 'Truth']
        for i in range(2):
            city = cities[i]
            basePath = outputPath + '/Result/' + city + '/' + 'shelter weight-' + str(shelter_weight) + '/' + granularity
            # for sigma in [0, 1]:
            storagePath = basePath + '/sigma=' + str(sigma)
            pic_storagePath = basePath + '/pic/sigma=' + str(sigma)
            shp = gpd.read_file(path + '/Data/' + cities[i] + '/' + shp_path[i])

            inflow = pd.read_csv(storagePath + '/' + type + 'PredTru.csv', header=0)
            merged = shp.merge(inflow, on='Tid') # 合并 inflow DataFrame 和 shapefile
            for j in range(2):
                scaler = MinMaxScaler()
                merged[fields[j]] = scaler.fit_transform(merged[[fields[j]]])

                inflow_data = merged[fields[j]].values

                # 设置坐标系为 WGS84 (经纬度)
                merged = merged.to_crs(epsg=4326)

                colors = ["#E4D3DF", "#CC96AF", "#BE7495", "#AC5281"]
                cmap = LinearSegmentedColormap.from_list("custom_pink", colors, N=256)
                norm = mcolors.FuncNorm((lambda x: boxcox_transform(x, lmbda), lambda x: inv_boxcox_transform(x, lmbda)), vmin=0, vmax=1)

                # 绘制地图
                fig, ax = plt.subplots(figsize=(10, 6))
                ax1 = fig.add_axes([0.92, 0.25, 0.03, 0.5])

                merged.plot(column=merged[fields[j]], ax=ax, norm=norm, cmap=cmap, edgecolor='white', linewidth=0.001, legend=False)
                # boundary_shp.plot(ax=ax, edgecolor='k', linewidth=1) # 绘制边界

                cbar = fig.colorbar(cm.ScalarMappable(norm=norm, cmap=cmap), cax=ax1, orientation='vertical')
                cbar.ax.tick_params(labelsize=12)
                cbar.outline.set_visible(False)

                # 关闭ax边框
                for spine in ax.spines.values():
                    spine.set_visible(False)

                # 添加经纬线
                ax.grid(True, which='both', color='gray', linestyle='--', linewidth=0.5)
                ax.set_axisbelow(True)
                ax.tick_params(axis='both', length=0, width=0, labelsize=12)

                filename = type + names[j] + 'Map_boxcox' + str(lmbda)
                plt.savefig(pic_storagePath + '/' + filename + '.pdf', format='pdf')
                plt.savefig(pic_storagePath + '/' + filename + '.png', dpi=300)

